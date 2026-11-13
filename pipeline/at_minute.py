"""Hero strength *at* a game minute, not by game length.

Win rate by game length mixes in stomps (the stronger side wins them, and they
end early). This measures each hero's game state at fixed minutes instead, from
the lake's stat snapshots (3, 6, 9, 12, 15, 20, 25 … 45 min):

  team_lead   the hero's team's soul lead at minute X, as % of all souls in the
              lobby (+2 = the team holds 51% of the souls). Comparable across
              minutes, and says whether the team tends to be ahead.
  soul_share  the hero's own souls vs the lobby average at minute X, in %
              (+10 = 10% more souls than the average player).

Matches where someone left are not counted, as in the power curves. Only matches
still running at minute X count at minute X, so late minutes skew
toward close games; the page says so. One hero appears once per match, so
observations are independent across matches and the 95% CI is mean ± 1.96·sd/√n.

  python -m pipeline.at_minute --days 30      # cached per day in data/cache/am_<day>.parquet
Writes data/at_minute.parquet (slice x hero x minute).
"""
import argparse
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline.build import KEYS, expand_slices
from pipeline.extract import MIN_DURATION_S, _rank_sql, assign_period
from pipeline.stats import Z95
from pipeline.win_factors import CACHE, FINAL_AFTER_DAYS, _query, _save
from pipeline.win_factors_sql import SNAPSHOT_S

VERSION = "am2"          # am2: leaver flag
MEMORY_LIMIT = "6GB"
VALUES = ["n", "s_lead", "ss_lead", "s_share", "ss_share"]

RAW = """
    SELECT match_id, hero_id, player_slot, team::VARCHAR AS team, won, start_time, average_badge,
           match_mode::VARCHAR AS queue, duration_s, "stats.time_stamp_s" AS ts, "stats.net_worth" AS nw,
           coalesce(abandon_match_time_s, 0) > 0 AS abandoned
    FROM dl.main.match_player
    WHERE start_time >= TIMESTAMPTZ '{day} 00:00:00+00' AND start_time < TIMESTAMPTZ '{next_day} 00:00:00+00'
      AND game_mode = 'Normal' AND match_mode IN ('Ranked', 'Unranked') AND match_outcome = 'TeamWin'
      AND NOT coalesce(not_scored, false) AND duration_s >= {min_duration}
"""

# runs on the downloaded day (temp table am_raw)
DAY = """
WITH dedup AS (
    SELECT * FROM am_raw QUALIFY row_number() OVER (PARTITION BY match_id, hero_id ORDER BY player_slot) = 1
),
players AS (        -- complete matches only: 12 players, 6 per team, 6 winners
    SELECT *, bool_or(abandoned) OVER (PARTITION BY match_id) AS leaver FROM dedup
    QUALIFY count(*) OVER (PARTITION BY match_id) = 12
        AND sum(won::INT) OVER (PARTITION BY match_id) = 6
        AND sum((team = 'Team0')::INT) OVER (PARTITION BY match_id) = 6
        AND bool_and(len(ts) = len(nw)) OVER (PARTITION BY match_id)
),
snap AS (           -- exact snapshots only, never the game-end one
    SELECT * FROM (
        SELECT match_id, hero_id, team, queue, average_badge, duration_s, start_time, leaver,
               unnest(ts)::BIGINT AS t, unnest(nw)::DOUBLE AS nw
        FROM players)
    WHERE t IN ({snapshots}) AND t < duration_s
),
w AS (
    SELECT *, sum(nw) OVER (PARTITION BY match_id, t) AS lobby,
              sum(nw) OVER (PARTITION BY match_id, t, team) AS own,
              count(*) OVER (PARTITION BY match_id, t) AS np
    FROM snap
),
x AS (
    SELECT (start_time AT TIME ZONE 'UTC')::DATE AS day, hero_id::INT AS hero_id, queue, {rank} AS rank, leaver,
           (t // 60)::INT AS minute,
           100 * (2 * own - lobby) / lobby AS lead,
           100 * (nw / (lobby / 12) - 1) AS share
    FROM w WHERE np = 12 AND lobby > 0
)
SELECT day, hero_id, queue, rank, leaver, minute, count(*)::BIGINT AS n,
       sum(lead) AS s_lead, sum(lead * lead) AS ss_lead, sum(share) AS s_share, sum(share * share) AS ss_share
FROM x GROUP BY ALL
"""


def fetch(days: int, refresh: bool = False) -> pd.DataFrame:
    """Per day x hero x queue x rank x minute sums, for the last `days` complete days."""
    import pyarrow.parquet as pq
    CACHE.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    wanted = [today - timedelta(days=i) for i in range(days, 0, -1)]
    con, out = [None], []
    for d in wanted:
        path = CACHE / f"am_{d}.parquet"
        final = (today - d).days >= FINAL_AFTER_DAYS and not refresh
        if final and path.exists() and (pq.read_schema(path).metadata or {}).get(b"am_version") == VERSION.encode():
            out.append(pd.read_parquet(path))
            continue
        t0 = time.time()
        raw = RAW.format(day=d, next_day=d + timedelta(days=1), min_duration=MIN_DURATION_S)
        sql = DAY.format(snapshots=",".join(map(str, SNAPSHOT_S)), rank=_rank_sql())

        def run(c, raw=raw, sql=sql):
            # without a cap DuckDB kept a whole day of stat lists in memory (over 20 GB); spill to disk instead
            c.execute(f"SET memory_limit = '{MEMORY_LIMIT}'; SET preserve_insertion_order = false; "
                      f"SET temp_directory = '{(CACHE / 'duckdb_tmp').as_posix()}'")
            c.execute(f"CREATE OR REPLACE TEMP TABLE am_raw AS {raw}")
            r = c.execute(sql).df()
            c.execute("DROP TABLE am_raw")
            return r
        r = _query(con, run, f"at-minute {d}", timeout=1500)
        if r is None:
            print(f"  {d}: skipped after 3 attempts", flush=True)
            continue
        r = r.astype({"hero_id": "int16", "minute": "int16", "n": "int64"})
        _save(r, path, {"am_version": VERSION})
        out.append(r)
        print(f"  {d}: {int(r.query('minute == 3')['n'].sum()) // 12:,} matches ({time.time() - t0:.0f}s)", flush=True)
    return pd.concat(out, ignore_index=True)


def summarise(sums: pd.DataFrame) -> pd.DataFrame:
    """Means and 95% CIs per slice x hero x minute from the summed values."""
    if "leaver" in sums:                       # same rule as the power curves: no matches where someone left
        sums = sums[~sums["leaver"].astype(bool)]
    df = assign_period(sums)
    s = expand_slices(df, VALUES, ["hero_id", "minute"])
    n = s["n"].to_numpy(float)
    out = s[["queue", "rank", "period", "hero_id", "minute", "n"]].copy()
    for name in ("lead", "share"):
        m = s[f"s_{name}"].to_numpy() / n
        sd = np.sqrt(np.clip(s[f"ss_{name}"].to_numpy() / n - m ** 2, 0, None))
        half = Z95 * sd / np.sqrt(n)
        out[name], out[f"{name}_low"], out[f"{name}_high"] = m, m - half, m + half
    out["enough"] = out["n"] >= C.MIN_GAMES_PER_BIN
    return out.sort_values(KEYS + ["minute"]).reset_index(drop=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    print(f"Hero state at each snapshot minute, last {args.days} complete days (cached days are skipped)…", flush=True)
    sums = fetch(args.days, args.refresh)
    out = summarise(sums)
    out.to_parquet(C.DATA_DIR / "at_minute.parquet", index=False)
    a = out[(out["queue"] == "all") & (out["rank"] == "all") & (out["period"] == "all")]
    print(f"{len(out):,} rows; {a['hero_id'].nunique()} heroes; minutes {sorted(a['minute'].unique())}")
    print(f"Wrote {C.DATA_DIR / 'at_minute.parquet'}")


if __name__ == "__main__":
    main()
