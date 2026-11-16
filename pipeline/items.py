"""Which items win games, once you account for who can afford them.

Raw item win rates are misleading: the team that is ahead has more souls and buys
more (and bigger) items, so almost every item "wins". Here each purchase is
compared with the same hero in the same game state:

  state      at the last stat snapshot before the purchase: the minute bucket, the
             buyer's team soul lead (in % of all souls, 2-point bins) and the buyer's
             own souls vs the average player in the match (15-point bins). The own
             souls matter: only a well-farmed player can afford an expensive item,
             and a team lead alone left that bias in (it1, before 2026-11-16).
  expected   the win rate of all player-snapshots in that state (baseline), plus
             the hero's own edge beyond the game state (strong heroes win more
             from any position)
  effect     observed win rate of the buyers minus expected, in percentage points
  effect_team  the same with the team soul lead only (the it1 method), for comparison

Each player's first purchase of an item counts once. 95% CIs are binomial on the
observed rate (purchases by teammates in one match are not independent, so they
are a little narrow). Matches where someone left are not counted.

  python -m pipeline.items --days 30     # cached per day in data/cache/it_<day>.parquet
Writes data/items.parquet (slice x item x timing) and data/items.json (item names, images, tiers).
"""
import argparse
import json
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline.build import KEYS, expand_slices
from pipeline.extract import MIN_DURATION_S, _rank_sql, assign_period
from pipeline.stats import Z95
from pipeline.win_factors import CACHE, FINAL_AFTER_DAYS, _query, _save

VERSION = "it2"          # it2: the buyer's own souls are part of the state
MEMORY_LIMIT = "10GB"            # a day of item lists needed more than 6 GB at peak
MIN_ITEM_GAMES = 2000                       # items with fewer purchases in a slice are not shown
MIN_BUCKET_GAMES = 500                      # nor purchase-minute buckets with fewer than this
LEAD_BIN = 2                                # % of all souls
LEAD_CLIP = 20
OWN_BIN = 15                                # % above or below the match's average player
OWN_CLIP = 45
# purchase-minute buckets: upper bounds in minutes (the last one is open)
BUCKETS = [5, 10, 15, 20, 25, 30, 40, 10_000]
BUCKET_LABELS = ["0–5", "5–10", "10–15", "15–20", "20–25", "25–30", "30–40", "40+"]
ASSETS = "https://api.deadlock-api.com/v1/assets/items"
SLICE_KEYS = KEYS[:-1]

RAW = """
    SELECT match_id, hero_id, player_slot, team::VARCHAR AS team, won, start_time, average_badge,
           match_mode::VARCHAR AS queue, duration_s, "stats.time_stamp_s" AS ts, "stats.net_worth" AS nw,
           "items.item_id" AS item_ids, "items.game_time_s" AS item_ts,
           coalesce(abandon_match_time_s, 0) > 0 AS abandoned
    FROM dl.main.match_player
    WHERE start_time >= TIMESTAMPTZ '{day} 00:00:00+00' AND start_time < TIMESTAMPTZ '{next_day} 00:00:00+00'
      AND game_mode = 'Normal' AND match_mode IN ('Ranked', 'Unranked') AND match_outcome = 'TeamWin'
      AND NOT coalesce(not_scored, false) AND duration_s >= {min_duration}
"""

# runs on the downloaded day (temp table it_raw). item_id 0 rows = the baseline (every player-snapshot).
DAY = """
WITH dedup AS (
    SELECT * FROM it_raw QUALIFY row_number() OVER (PARTITION BY match_id, hero_id ORDER BY player_slot) = 1
),
players AS (
    SELECT *, bool_or(abandoned) OVER (PARTITION BY match_id) AS leaver FROM dedup
    QUALIFY count(*) OVER (PARTITION BY match_id) = 12
        AND sum(won::INT) OVER (PARTITION BY match_id) = 6
        AND sum((team = 'Team0')::INT) OVER (PARTITION BY match_id) = 6
        AND bool_and(len(ts) = len(nw)) OVER (PARTITION BY match_id)
        AND bool_and(len(item_ids) = len(item_ts)) OVER (PARTITION BY match_id)
),
snap AS (
    SELECT * FROM (
        SELECT match_id, hero_id, team, duration_s, unnest(ts)::BIGINT AS t, unnest(nw)::DOUBLE AS nw FROM players)
    WHERE t > 0 AND t < duration_s
),
player_own AS (     -- each player's souls vs the match's average player at each snapshot, in %
    SELECT match_id, hero_id, t, 100 * (nw * cnt / lobby - 1) AS own FROM (
        SELECT match_id, hero_id, t, nw, sum(nw) OVER (PARTITION BY match_id, t) AS lobby,
               count(*) OVER (PARTITION BY match_id, t) AS cnt
        FROM snap)
    WHERE lobby > 0 AND cnt = 12
),
team_lead AS (      -- each team's soul lead at each snapshot, % of all souls
    SELECT match_id, team, t, 100 * (2 * own - lobby) / lobby AS lead FROM (
        SELECT match_id, team, t, sum(nw) AS own, sum(sum(nw)) OVER (PARTITION BY match_id, t) AS lobby,
               count(*) OVER (PARTITION BY match_id, t) AS teams
        FROM snap GROUP BY match_id, team, t)
    WHERE lobby > 0 AND teams = 2
),
base AS (           -- every player at every snapshot: the game-state baseline
    SELECT p.start_time, p.hero_id, p.queue, p.average_badge, p.leaver, p.won, l.t, l.lead, o.own
    FROM players p JOIN team_lead l ON p.match_id = l.match_id AND p.team = l.team
                   JOIN player_own o ON o.match_id = p.match_id AND o.hero_id = p.hero_id AND o.t = l.t
),
buys AS (           -- first purchase of each shop item per player
    SELECT match_id, hero_id, team, won, start_time, queue, average_badge, leaver, item_id, min(bt) AS bt FROM (
        SELECT match_id, hero_id, team, won, start_time, queue, average_badge, leaver,
               unnest(item_ids)::BIGINT AS item_id, unnest(item_ts)::BIGINT AS bt
        FROM players)
    WHERE item_id IN ({items}) AND bt > 0
    GROUP BY ALL
),
at_lead AS (
    SELECT b.*, coalesce(l.lead, 0) AS lead
    FROM buys b ASOF LEFT JOIN team_lead l ON b.match_id = l.match_id AND b.team = l.team AND b.bt >= l.t
),
at_buy AS (         -- before the first snapshot everyone is level: own = 0
    SELECT b.*, coalesce(o.own, 0) AS own
    FROM at_lead b ASOF LEFT JOIN player_own o ON b.match_id = o.match_id AND b.hero_id = o.hero_id AND b.bt >= o.t
),
binned AS (
    SELECT (start_time AT TIME ZONE 'UTC')::DATE AS day, queue, {rank} AS rank, leaver, won,
           item_id, hero_id::SMALLINT AS hero_id, ({bucket})::TINYINT AS bucket,
           (greatest(-{clip}, least({clip}, round(lead / {bin}) * {bin})))::TINYINT AS lead_bin,
           (greatest(-{own_clip}, least({own_clip}, round(own / {own_bin}) * {own_bin})))::TINYINT AS own_bin
    FROM (SELECT start_time, hero_id, queue, average_badge, leaver, won, item_id, bt AS t, lead, own FROM at_buy
          UNION ALL
          SELECT start_time, hero_id, queue, average_badge, leaver, won, 0 AS item_id, t, lead, own FROM base)
)
-- The expected rate is additive (state win rate + hero edge), so purchases are counted two ways
-- instead of by hero x state, which keeps the table small:
--   baseline (item 0): hero x state;  purchases: item x state (hero_id = -1)  and  item x hero x minute (bins = 127)
SELECT day, queue, rank, leaver, item_id, hero_id, bucket, lead_bin, own_bin, count(*)::INT AS n, sum(won::INT)::INT AS wins
FROM binned WHERE item_id = 0 GROUP BY ALL
UNION ALL
SELECT day, queue, rank, leaver, item_id, -1::SMALLINT, bucket, lead_bin, own_bin, count(*)::INT, sum(won::INT)::INT
FROM binned WHERE item_id <> 0 GROUP BY ALL
UNION ALL
SELECT day, queue, rank, leaver, item_id, hero_id, bucket, 127::TINYINT, 127::TINYINT, count(*)::INT, sum(won::INT)::INT
FROM binned WHERE item_id <> 0 GROUP BY ALL
"""
ALL_BINS = 127                  # lead_bin / own_bin of the item x hero rows: summed over every state


def _bucket_sql(col: str = "t") -> str:
    parts = [f"WHEN {col} < {b * 60} THEN {i}" for i, b in enumerate(BUCKETS[:-1])]
    return "CASE " + " ".join(parts) + f" ELSE {len(BUCKETS) - 1} END"


def shop_items() -> list[dict]:
    req = urllib.request.Request(ASSETS, headers={"User-Agent": "deadlock-power-curves (portfolio project)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        items = json.loads(r.read().decode("utf-8"))
    return [{"id": int(x["id"]), "name": x["name"], "tier": x.get("item_tier"), "cost": x.get("cost"),
             "slot": x.get("item_slot_type"), "image": x.get("shop_image_small") or x.get("image")}
            for x in items if x.get("type") == "upgrade" and x.get("shopable") and not x.get("disabled")]


def fetch(days: int, item_ids: list[int], refresh: bool = False) -> pd.DataFrame:
    import pyarrow.parquet as pq
    CACHE.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    con, out = [None], []
    for d in [today - timedelta(days=i) for i in range(days, 0, -1)]:
        path = CACHE / f"it_{d}.parquet"
        final = (today - d).days >= FINAL_AFTER_DAYS and not refresh
        if final and path.exists() and (pq.read_schema(path).metadata or {}).get(b"it_version") == VERSION.encode():
            out.append(pd.read_parquet(path))
            continue
        t0 = time.time()
        raw = RAW.format(day=d, next_day=d + timedelta(days=1), min_duration=MIN_DURATION_S)
        sql = DAY.format(items=",".join(map(str, item_ids)), rank=_rank_sql(), bucket=_bucket_sql(),
                         clip=LEAD_CLIP, bin=LEAD_BIN, own_clip=OWN_CLIP, own_bin=OWN_BIN)

        def run(c, raw=raw, sql=sql):
            # the connection already spills to data/cache/duckdb_tmp; setting that again fails once it was used
            c.execute(f"SET memory_limit = '{MEMORY_LIMIT}'")
            c.execute(f"CREATE OR REPLACE TEMP TABLE it_raw AS {raw}")
            r = c.execute(sql).df()
            c.execute("DROP TABLE it_raw")
            return r
        r = _query(con, run, f"items {d}", timeout=1800)
        if r is None:
            print(f"  {d}: skipped after 3 attempts", flush=True)
            continue
        r = r.astype({"item_id": "int64", "hero_id": "int16", "bucket": "int8", "lead_bin": "int8", "own_bin": "int8",
                      "n": "int64", "wins": "int64"})
        _save(r, path, {"it_version": VERSION})
        out.append(r)
        print(f"  {d}: {int(r[r['item_id'] != 0]['n'].sum()):,} purchases ({time.time() - t0:.0f}s)", flush=True)
    return pd.concat(out, ignore_index=True)


def _split(rows: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Baseline (hero x state), purchases by item x state, purchases by item x hero x minute.
    Accepts the compact cache layout (see DAY) or one row per item x hero x state (tests)."""
    if "own_bin" not in rows:
        rows = rows.assign(own_bin=0)
    base, it = rows[rows["item_id"] == 0], rows[rows["item_id"] != 0]
    keys = ["item_id", "bucket", "lead_bin", "own_bin"]
    if (it["hero_id"] == -1).any():
        by_state = it[it["hero_id"] == -1]
        by_hero = it[it["lead_bin"] == ALL_BINS]
    else:
        by_state = it.groupby(keys, as_index=False)[["n", "wins"]].sum()
        by_hero = it.groupby(["item_id", "hero_id", "bucket"], as_index=False)[["n", "wins"]].sum()
    return base, by_state, by_hero


def _parts(base: pd.DataFrame, state: list[str]) -> tuple[pd.Series, pd.Series]:
    """Win rate of each game state, and each hero's edge beyond the state (from its own snapshots)."""
    st = base.groupby(state)[["n", "wins"]].sum()
    state_wr = (st["wins"] / st["n"]).rename("state_wr")
    b = base.join(state_wr, on=state)
    hero_edge = ((b["wins"] - b["n"] * b["state_wr"]).groupby(b["hero_id"]).sum()
                 / b.groupby("hero_id")["n"].sum()).rename("hero_edge")
    return state_wr, hero_edge


def effects(rows: pd.DataFrame) -> pd.DataFrame:
    """One slice: per item, overall (bucket -1) and per purchase-minute bucket.
    Expected = the state's baseline win rate + the hero's edge beyond the state, so the
    purchases' state part and hero part can be summed separately."""
    base, by_state, by_hero = _split(rows)
    full, team = ["bucket", "lead_bin", "own_bin"], ["bucket", "lead_bin"]
    s = by_state.copy()
    h = by_hero.copy()
    for name, state in (("", full), ("_team", team)):
        state_wr, hero_edge = _parts(base, state)
        s[f"st{name}"] = s["n"] * s.join(state_wr, on=state)["state_wr"].fillna(0.5)
        h[f"he{name}"] = h["n"] * h.join(hero_edge, on="hero_id")["hero_edge"].fillna(0.0)
    s["lead_w"], s["own_w"] = s["n"] * s["lead_bin"], s["n"] * s["own_bin"]

    def summarise(keys: list[str]) -> pd.DataFrame:
        a = s.groupby(keys)[["n", "wins", "st", "st_team", "lead_w", "own_w"]].sum()
        a = a.join(h.groupby(keys)[["he", "he_team"]].sum()).fillna({"he": 0.0, "he_team": 0.0}).reset_index()
        a["win_rate"] = a["wins"] / a["n"]
        a["expected"] = (a["st"] + a["he"]) / a["n"]
        a["lead"] = a["lead_w"] / a["n"]                       # average team soul lead when bought
        a["own"] = a["own_w"] / a["n"]                         # average buyer's souls vs the match average, %
        se = np.sqrt(a["win_rate"] * (1 - a["win_rate"]) / a["n"])
        a["effect"] = (a["win_rate"] - a["expected"]) * 100
        a["effect_team"] = (a["win_rate"] - (a["st_team"] + a["he_team"]) / a["n"]) * 100
        a["ci_low"], a["ci_high"] = a["effect"] - Z95 * se * 100, a["effect"] + Z95 * se * 100
        return a.drop(columns=["st", "st_team", "he", "he_team", "lead_w", "own_w"])

    overall = summarise(["item_id"]).assign(bucket=-1)
    # typical purchase minute: the bucket holding the median purchase
    cum = s.groupby(["item_id", "bucket"])["n"].sum().groupby(level=0).cumsum()
    tot = s.groupby("item_id")["n"].sum()
    med = cum[cum >= tot.reindex(cum.index.get_level_values(0)).to_numpy() / 2].reset_index().groupby("item_id")["bucket"].first()
    overall["median_bucket"] = overall["item_id"].map(med)
    timing = summarise(["item_id", "bucket"])
    shown = set(overall.loc[overall["n"] >= MIN_ITEM_GAMES, "item_id"])
    timing = timing[timing["item_id"].isin(shown) & (timing["n"] >= MIN_BUCKET_GAMES)]
    return pd.concat([overall[overall["item_id"].isin(shown)], timing], ignore_index=True)


def build(raw: pd.DataFrame) -> pd.DataFrame:
    raw = raw[~raw["leaver"].astype(bool)]
    dims = ["item_id", "hero_id", "bucket", "lead_bin"] + (["own_bin"] if "own_bin" in raw else [])
    s = expand_slices(assign_period(raw), ["n", "wins"], dims)
    out = [effects(g).assign(queue=q, rank=r, period=p) for (q, r, p), g in s.groupby(SLICE_KEYS)]
    t = pd.concat(out, ignore_index=True)
    return t.astype({"item_id": "int64", "bucket": "int8", "n": "int64", "wins": "int64"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    items = shop_items()
    print(f"Items, last {args.days} complete days ({len(items)} shop items; cached days are skipped)…", flush=True)
    raw = fetch(args.days, [x["id"] for x in items], args.refresh)
    t = build(raw)
    t.to_parquet(C.DATA_DIR / "items.parquet", index=False)
    days = sorted(pd.to_datetime(raw["day"]).dt.date.unique())
    seen = set(t["item_id"].unique())
    (C.DATA_DIR / "items.json").write_text(json.dumps({
        "first_day": str(days[0]), "last_day": str(days[-1]), "min_games": MIN_ITEM_GAMES,
        "buckets": BUCKET_LABELS, "leavers_excluded": True, "own_souls": True,
        "items": [x for x in items if x["id"] in seen]}, indent=1), encoding="utf-8")
    a = t[(t["queue"] == "all") & (t["rank"] == "all") & (t["period"] == "all") & (t["bucket"] == -1)]
    print(f"{len(t):,} rows over {t.groupby(SLICE_KEYS).ngroups} slices; {len(a)} items in the all slice")
    raw_edge = (a["win_rate"] - 0.5) * 100
    print(f"average |edge|: raw {raw_edge.abs().mean():.2f} pp, team lead only {a['effect_team'].abs().mean():.2f}, "
          f"with own souls {a['effect'].abs().mean():.2f}")
    print(a.assign(raw=raw_edge).sort_values("effect")[["item_id", "n", "win_rate", "expected", "effect", "effect_team", "own", "raw"]]
          .round(3).to_string(max_rows=20))


if __name__ == "__main__":
    main()
