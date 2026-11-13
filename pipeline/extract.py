"""Pull match data and aggregate it to small count tables inside DuckDB.

The lake is ~700 GB of Parquet over HTTP, partitioned by match_id. One big
30-day query can hang on a single stalled connection, so the real pull runs
one UTC day at a time, each with a timeout and retries, and caches that day's
aggregated counts in data/cache/. Reruns only fetch days not cached yet (plus
the most recent ones, which are still filling in).

Only aggregated counts (day x hero x queue x rank x length bucket x leaver) come
back to Python. `leaver` = someone in the match abandoned it. Those matches are
left out of the power curves (see LEAVERS in build.py): 86% of games under 20
minutes have a leaver, and the leaver's team wins 0.2% of them, so short games
said more about who quits than about heroes. Patches are assigned afterwards from the day (see assign_period), so
editing PATCHES never needs a re-download.
"""
import threading
import time
from datetime import date, datetime, timedelta, timezone

import duckdb
import pandas as pd

from pipeline.config import BIN_EDGES_MIN, DATA_DIR, PATCHES, RANK_BRACKETS

MIN_DURATION_S = 8 * 60          # drop remakes / early abandons
CACHE_DIR = DATA_DIR / "cache"
FINAL_AFTER_DAYS = 2             # days younger than this are refetched (late ingestion)
DAY_TIMEOUT_S = 600
RETRIES = 3

# One row per player per full, scored, normal 6v6 match started on one UTC day.
# Schema notes (see schema.md): match_player is denormalised, so no join.
LAKE_DAY = """
WITH raw AS (
    SELECT match_id, hero_id, won, duration_s, start_time, average_badge,
           match_mode::VARCHAR AS queue, coalesce(abandon_match_time_s, 0) > 0 AS abandoned
    FROM dl.main.match_player
    WHERE start_time >= TIMESTAMPTZ '{day} 00:00:00+00'
      AND start_time <  TIMESTAMPTZ '{next_day} 00:00:00+00'
      AND game_mode = 'Normal'
      AND match_mode IN ('Ranked', 'Unranked')
      AND match_outcome = 'TeamWin'
      AND NOT coalesce(not_scored, false)
      AND duration_s >= {min_duration}
),
dedup AS (          -- the lake can hold unmerged duplicate rows
    SELECT * FROM raw
    QUALIFY row_number() OVER (PARTITION BY match_id, hero_id ORDER BY start_time) = 1
)
SELECT * EXCLUDE (abandoned), bool_or(abandoned) OVER (PARTITION BY match_id) AS leaver FROM dedup  -- keep complete matches only: 12 players, 6 winners
QUALIFY count(*) OVER (PARTITION BY match_id) = 12
    AND sum(won::INT) OVER (PARTITION BY match_id) = 6
"""


def _bucket_sql(col="duration_s"):
    parts = [f"WHEN {col} < {int(hi * 60)} THEN {i}" for i, hi in enumerate(BIN_EDGES_MIN[1:-1])]
    return f"CASE {' '.join(parts)} ELSE {len(BIN_EDGES_MIN) - 2} END"


def _rank_sql():
    parts = [f"WHEN average_badge >= {lo} AND average_badge < {hi} THEN '{rid}'"
             for rid, _, lo, hi in RANK_BRACKETS]
    return f"CASE WHEN queue <> 'Ranked' OR average_badge IS NULL THEN 'none' {' '.join(parts)} ELSE 'none' END"


AGG = """
SELECT (start_time AT TIME ZONE 'UTC')::DATE AS day,
       hero_id::INT AS hero_id, queue, {rank} AS rank, {bucket} AS bucket_idx, leaver,
       sum(won::INT)::BIGINT AS wins, count(*)::BIGINT AS games
FROM players GROUP BY ALL
"""

TOTALS = """
SELECT (start_time AT TIME ZONE 'UTC')::DATE AS day, queue, {rank} AS rank, leaver,
       count(DISTINCT match_id) AS matches, count(*) AS player_rows,
       min(start_time) AS first_match, max(start_time) AS last_match
FROM players GROUP BY ALL
"""


def aggregate(con: duckdb.DuckDBPyConnection, players_sql: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    con.execute(f"CREATE OR REPLACE TEMP TABLE players AS {players_sql}")
    fmt = dict(rank=_rank_sql(), bucket=_bucket_sql())
    counts = con.execute(AGG.format(**fmt)).df()
    totals = con.execute(TOTALS.format(**fmt)).df()
    return counts, totals


def assign_period(df: pd.DataFrame) -> pd.DataFrame:
    """Patch label from the match day. PATCHES = [(label, 'YYYY-MM-DD'), ...]."""
    df = df.copy()
    days = pd.to_datetime(df["day"])
    df["period"] = "all" if not PATCHES else "earlier"
    for label, start in sorted(PATCHES, key=lambda p: p[1]):
        df.loc[days >= pd.Timestamp(start), "period"] = label
    return df


# ---------------------------------------------------------------------------
# Real data: day-by-day with timeout, retries and a local cache
# ---------------------------------------------------------------------------
def _run_with_timeout(con, fn, timeout_s):
    """Run fn(con); interrupt DuckDB if it takes longer than timeout_s."""
    timer = threading.Timer(timeout_s, con.interrupt)
    timer.start()
    try:
        return fn(con)
    finally:
        timer.cancel()


def _connect():
    from pipeline.lake import connect
    con = connect()
    con.execute("SET http_timeout = 60; SET http_retries = 5; SET http_retry_wait_ms = 500;")
    # cap DuckDB's memory and let it spill to disk (uncapped, a day of stat lists took over 20 GB)
    tmp = (DATA_DIR / "cache" / "duckdb_tmp").as_posix()
    con.execute(f"SET memory_limit = '8GB'; SET preserve_insertion_order = false; SET temp_directory = '{tmp}';")
    return con


def fetch_day(day: date, con=None) -> tuple[tuple[pd.DataFrame, pd.DataFrame], "duckdb.DuckDBPyConnection"]:
    """(counts, totals) for one day, and the connection to keep using (a failed attempt replaces it)."""
    sql = LAKE_DAY.format(day=day, next_day=day + timedelta(days=1), min_duration=MIN_DURATION_S)
    last = None
    for attempt in range(1, RETRIES + 1):
        con = con or _connect()
        try:
            return _run_with_timeout(con, lambda c: aggregate(c, sql), DAY_TIMEOUT_S), con
        except Exception as e:      # timeout (interrupt), HTTP errors, dropped connections
            last = e
            print(f"  {day}: attempt {attempt} failed ({str(e).splitlines()[0][:120]})", flush=True)
            try:
                con.close()
            except Exception:
                pass
            con = None
            time.sleep(5 * attempt)
    raise RuntimeError(f"{day}: gave up after {RETRIES} attempts") from last


def _has_leaver(path) -> bool:
    """Caches from before the leaver flag are refetched."""
    import pyarrow.parquet as pq
    return "leaver" in pq.read_schema(path).names


def from_lake(days: int, refresh: bool = False):
    """Aggregated counts for the last `days` complete-or-recent UTC days."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    wanted = [today - timedelta(days=i) for i in range(days, -1, -1)]   # includes today (partial)
    con, counts, totals, failed = None, [], [], []
    for d in wanted:
        c_path, t_path = CACHE_DIR / f"counts_{d}.parquet", CACHE_DIR / f"totals_{d}.parquet"
        final = (today - d).days >= FINAL_AFTER_DAYS
        if final and not refresh and c_path.exists() and t_path.exists() and _has_leaver(c_path):
            counts.append(pd.read_parquet(c_path)); totals.append(pd.read_parquet(t_path))
            continue
        t0 = time.time()
        try:
            if con is None:
                con = _connect()
            (c, t), con = fetch_day(d, con)
        except RuntimeError as e:
            print(f"  {e}; skipping this day", flush=True)
            failed.append(d); con = None
            continue
        c.to_parquet(c_path, index=False); t.to_parquet(t_path, index=False)
        counts.append(c); totals.append(t)
        print(f"  {d}: {int(t['matches'].sum()):>7,} matches  ({time.time() - t0:.0f}s)", flush=True)
    # drop cache files that fell out of the window so the cache doesn't grow forever
    keep = {f"{k}_{d}.parquet" for d in wanted for k in ("counts", "totals")}
    for f in [*CACHE_DIR.glob("counts_*.parquet"), *CACHE_DIR.glob("totals_*.parquet")]:
        if f.name not in keep:
            f.unlink()
    if failed:
        print(f"warning: {len(failed)} day(s) missing: {', '.join(map(str, failed))}. Rerun to retry them.")
    counts = pd.concat([c for c in counts if len(c)], ignore_index=True)
    totals = pd.concat([t for t in totals if len(t)], ignore_index=True)
    return assign_period(counts), assign_period(totals)


def from_frame(df: pd.DataFrame):
    """Same aggregation on an in-memory player table (demo / tests)."""
    con = duckdb.connect()
    if "leaver" not in df:
        df = df.assign(leaver=False)
    con.register("players_df", df)
    counts, totals = aggregate(con, "SELECT * FROM players_df")
    return assign_period(counts), assign_period(totals)
