"""Best partners and counters per hero, sliced like the power curves.

Its own lake pull (data/cache/pp_<day>.parquet: per day, queue, rank bracket,
leaver flag and pair of heroes, on the same team or on opposite teams, games and
wins of the first hero's side). The win model's hp_* caches are left alone: the
model was trained on them.

For a pair, the *expected* win rate comes from the two heroes' own win rates in
the same matches (with: 50% + edge(a) + edge(b); against: 50% + edge(a) - edge(b)).
The *effect* is the observed win rate minus that, in percentage points:
  with     +2 = the two win 2 points more often together than their own strength suggests
  against  +2 = hero a's side beats hero b's side 2 points more often than expected
Shown with a 95% CI (binomial, on the observed rate). Ranked by the effect
shrunk toward 0 by PAIR_PRIOR pseudo-games (the shrinkage the win model's draft
factors use), so a small, noisy pair does not top the list. Matches where
someone left are not counted, as in the power curves.

  python -m pipeline.hero_pairs --days 30      # writes data/hero_pairs.parquet
"""
import argparse
import json
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline.build import KEYS, expand_slices
from pipeline.extract import MIN_DURATION_S, _rank_sql, assign_period
from pipeline.stats import Z95
from pipeline.win_factors import CACHE, FINAL_AFTER_DAYS, PAIR_PRIOR, _query, _save

MIN_PAIR_GAMES = 1000                          # pairs with fewer games in a slice are not shown
VERSION = "pp1"
SLICE_KEYS = KEYS[:-1]                         # queue, rank, period

DAY = """
WITH raw AS (
    SELECT match_id, hero_id::INT AS hero_id, player_slot, team::VARCHAR AS team, won, start_time, average_badge,
           match_mode::VARCHAR AS queue, coalesce(abandon_match_time_s, 0) > 0 AS abandoned
    FROM dl.main.match_player
    WHERE start_time >= TIMESTAMPTZ '{day} 00:00:00+00' AND start_time < TIMESTAMPTZ '{next_day} 00:00:00+00'
      AND game_mode = 'Normal' AND match_mode IN ('Ranked', 'Unranked') AND match_outcome = 'TeamWin'
      AND NOT coalesce(not_scored, false) AND duration_s >= {min_duration}
    QUALIFY row_number() OVER (PARTITION BY match_id, hero_id ORDER BY player_slot) = 1
),
p AS (
    SELECT *, bool_or(abandoned) OVER (PARTITION BY match_id) AS leaver FROM raw
    QUALIFY count(*) OVER (PARTITION BY match_id) = 12 AND sum(won::INT) OVER (PARTITION BY match_id) = 6
)
SELECT (a.start_time AT TIME ZONE 'UTC')::DATE AS day, a.queue, {rank} AS rank, a.leaver,
       a.hero_id::SMALLINT AS h1, b.hero_id::SMALLINT AS h2, (a.team = b.team) AS same,
       count(*)::INT AS n, sum(a.won::INT)::INT AS wins
FROM p a JOIN p b ON a.match_id = b.match_id AND a.hero_id < b.hero_id
GROUP BY ALL
"""


def fetch(days: int, refresh: bool = False) -> pd.DataFrame:
    import pyarrow.parquet as pq
    CACHE.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    con, out = [None], []
    for d in [today - timedelta(days=i) for i in range(days, 0, -1)]:
        path = CACHE / f"pp_{d}.parquet"
        final = (today - d).days >= FINAL_AFTER_DAYS and not refresh
        if final and path.exists() and (pq.read_schema(path).metadata or {}).get(b"pp_version") == VERSION.encode():
            out.append(pd.read_parquet(path))
            continue
        t0 = time.time()
        sql = DAY.format(day=d, next_day=d + timedelta(days=1), min_duration=MIN_DURATION_S,
                         rank=_rank_sql().replace("queue", "a.queue").replace("average_badge", "a.average_badge"))
        r = _query(con, lambda c, sql=sql: c.execute(sql).df(), f"hero pairs {d}", timeout=1200)
        if r is None:
            print(f"  {d}: skipped after 3 attempts", flush=True)
            continue
        _save(r, path, {"pp_version": VERSION})
        out.append(r)
        print(f"  {d}: {int(r['n'].sum()) // 66:,} matches ({time.time() - t0:.0f}s)", flush=True)
    return pd.concat(out, ignore_index=True)


def table(pairs: pd.DataFrame, prior: float = PAIR_PRIOR) -> pd.DataFrame:
    """One row per (hero, other hero, with/against), from the hero's point of view.
    `pairs`: h1 < h2, same, n, wins (one slice)."""
    pairs = pairs.groupby(["h1", "h2", "same"], as_index=False)[["n", "wins"]].sum()
    x = pairs[~pairs["same"]]
    games = pd.concat([x.groupby("h1")["n"].sum(), x.groupby("h2")["n"].sum()]).groupby(level=0).sum()
    wins = pd.concat([x.groupby("h1")["wins"].sum(), (x["n"] - x["wins"]).groupby(x["h2"]).sum()]).groupby(level=0).sum()
    edge = (wins / games - 0.5).to_dict()                  # each hero's win rate above 50%, same matches
    p = pairs.copy()
    e1, e2 = p["h1"].map(edge).fillna(0.0), p["h2"].map(edge).fillna(0.0)
    p["expected"] = 0.5 + e1 + np.where(p["same"], e2, -e2)
    p["win_rate"] = p["wins"] / p["n"]
    # both directions: for "against", hero b's view is the mirror of hero a's
    a = p.assign(hero=p["h1"], other=p["h2"])
    b = p.assign(hero=p["h2"], other=p["h1"])
    b.loc[~b["same"], "win_rate"] = 1 - b.loc[~b["same"], "win_rate"]
    b.loc[~b["same"], "expected"] = 1 - b.loc[~b["same"], "expected"]
    t = pd.concat([a, b], ignore_index=True)
    se = np.sqrt(t["win_rate"] * (1 - t["win_rate"]) / t["n"])
    t["effect"] = (t["win_rate"] - t["expected"]) * 100
    t["ci_low"], t["ci_high"] = t["effect"] - Z95 * se * 100, t["effect"] + Z95 * se * 100
    t["shrunk"] = t["effect"] * t["n"] / (t["n"] + prior)
    t["kind"] = np.where(t["same"], "with", "against")
    t = t[t["n"] >= MIN_PAIR_GAMES]
    cols = ["hero", "other", "kind", "n", "win_rate", "expected", "effect", "ci_low", "ci_high", "shrunk"]
    return t[cols].astype({"hero": "int16", "other": "int16", "n": "int64"}).sort_values(
        ["hero", "kind", "shrunk"], ascending=[True, True, False]).reset_index(drop=True)


def build(raw: pd.DataFrame) -> pd.DataFrame:
    """Every UI slice (queue x rank x patch), without matches where someone left."""
    raw = raw[~raw["leaver"].astype(bool)]
    s = expand_slices(assign_period(raw), ["n", "wins"], ["h1", "h2", "same"])
    out = [table(g).assign(queue=q, rank=r, period=p) for (q, r, p), g in s.groupby(SLICE_KEYS)]
    return pd.concat(out, ignore_index=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    print(f"Hero pairs, last {args.days} complete days (cached days are skipped)…", flush=True)
    raw = fetch(args.days, args.refresh)
    t = build(raw)
    t.to_parquet(C.DATA_DIR / "hero_pairs.parquet", index=False)
    days = sorted(pd.to_datetime(raw["day"]).dt.date.unique())
    (C.DATA_DIR / "hero_pairs.json").write_text(json.dumps({
        "first_day": str(days[0]), "last_day": str(days[-1]), "min_games": MIN_PAIR_GAMES, "prior": PAIR_PRIOR,
        "leavers_excluded": True}), encoding="utf-8")
    a = t[(t["queue"] == "all") & (t["rank"] == "all") & (t["period"] == "all")]
    print(f"{len(t):,} rows over {t.groupby(SLICE_KEYS).ngroups} slices; all matches: {len(a):,} rows, "
          f"effects {a['effect'].min():.1f} to {a['effect'].max():.1f} pp")
    print(f"Wrote {C.DATA_DIR / 'hero_pairs.parquet'}")


if __name__ == "__main__":
    main()
