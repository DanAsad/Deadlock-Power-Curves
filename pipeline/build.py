"""Build the precomputed tables the API serves.

Run from the repo root:
  python -m pipeline.build --demo          # synthetic data, offline, ~5 s
  python -m pipeline.build --days 30       # real data from the data lake, day by day, cached in data/cache

Writes to ./data:
  power_curves.parquet   slice x hero x length bucket: wins, games, win rate, 95% CI
  scaling_index.parquet  slice x hero: pp win rate per extra 10 min, 95% CI, totals
  heroes.json            id, name, image URLs
  meta.json              filter options, sample sizes, thresholds, provenance

A "slice" is one combination of the UI filters: queue x rank bracket x patch.
"""
import argparse
import json
from datetime import datetime, timezone

import pandas as pd

from pipeline import config as C
from pipeline.extract import from_frame, from_lake
from pipeline.heroes import fetch_heroes, hero_table
from pipeline.stats import power_curves, scaling_index

KEYS = ["queue", "rank", "period", "hero_id"]
# Matches where someone left are not counted: they decide most short games (see extract.py).
LEAVERS = False

# (queue filter, rank filter) pairs the UI offers. Rank only exists for Ranked.
QUEUE_RANK = [("all", "all"), ("ranked", "all"), ("unranked", "all")] + \
             [("ranked", rid) for rid, *_ in C.RANK_BRACKETS]


def _select(df: pd.DataFrame, queue: str, rank: str, period: str) -> pd.DataFrame:
    m = pd.Series(True, index=df.index)
    if queue != "all":
        m &= df["queue"].str.lower() == queue
    if rank != "all":
        m &= df["rank"] == rank
    if period != "all":
        m &= df["period"] == period
    return df[m]


def expand_slices(df: pd.DataFrame, value_cols: list[str], by: list[str]) -> pd.DataFrame:
    """Sum raw (queue, rank, period) groups into every UI filter combination."""
    periods = ["all"] + (sorted(df["period"].unique()) if C.PATCHES else [])
    out = []
    for q, r in QUEUE_RANK:
        for p in periods:
            s = _select(df, q, r, p)
            if s.empty:
                continue
            agg = s.groupby(by, as_index=False)[value_cols].sum() if by else s[value_cols].sum().to_frame().T
            out.append(agg.assign(queue=q, rank=r, period=p))
    return pd.concat(out, ignore_index=True)


def build(counts: pd.DataFrame, totals: pd.DataFrame, assets: dict, source: dict):
    C.DATA_DIR.mkdir(exist_ok=True)
    left = totals.loc[totals["leaver"].astype(bool), "matches"].sum() if "leaver" in totals else 0
    all_matches = totals["matches"].sum()
    if not LEAVERS and "leaver" in counts:
        counts = counts[~counts["leaver"].astype(bool)]
        totals = totals[~totals["leaver"].astype(bool)]
    sliced = expand_slices(counts, ["wins", "games"], ["hero_id", "bucket_idx"])
    curves = power_curves(sliced, KEYS)
    index = scaling_index(curves, KEYS)

    curves.to_parquet(C.DATA_DIR / "power_curves.parquet", index=False)
    index.to_parquet(C.DATA_DIR / "scaling_index.parquet", index=False)

    heroes = hero_table(counts["hero_id"].unique(), assets)
    (C.DATA_DIR / "heroes.json").write_text(json.dumps(heroes, indent=1), encoding="utf-8")

    tot = expand_slices(totals, ["matches", "player_rows"], [])
    span = (totals["first_match"].min(), totals["last_match"].max())
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **source,
        "first_match": span[0].isoformat(), "last_match": span[1].isoformat(),
        "bins": [{"idx": i, "label": l, "mid_min": m} for i, (l, m) in enumerate(zip(C.BIN_LABELS, C.BIN_MIDS))],
        "min_games_per_bin": C.MIN_GAMES_PER_BIN,
        "leaver_matches_excluded": int(left), "leaver_share": round(float(left / max(all_matches, 1)), 4),
        "min_bins_for_index": C.MIN_BINS_FOR_INDEX,
        "filters": {
            "queue": [{"id": "all", "label": "All queues"}, {"id": "ranked", "label": "Ranked"},
                      {"id": "unranked", "label": "Unranked"}],
            "rank": [{"id": "all", "label": "All ranks"}] +
                    [{"id": rid, "label": lab} for rid, lab, *_ in C.RANK_BRACKETS],
            "period": [{"id": "all", "label": "All patches"}] +
                      [{"id": p, "label": p} for p in sorted(set(index["period"]) - {"all"})],
        },
        # matches per slice, for "n = ..." labels; keys are "queue|rank|period"
        "sample_sizes": {f"{r.queue}|{r.rank}|{r.period}": {"matches": int(r.matches), "player_rows": int(r.player_rows)}
                         for r in tot.itertuples()},
    }
    (C.DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return curves, index, heroes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="synthetic data, no network needed")
    ap.add_argument("--days", type=int, default=30, help="days of matches to pull from the lake")
    ap.add_argument("--refresh", action="store_true", help="ignore data/cache and refetch every day")
    args = ap.parse_args()

    if args.demo:
        from pipeline.demo import make_demo
        counts, totals = from_frame(make_demo())
        assets, source = {}, {"source": "demo", "days": 30}
    else:
        print(f"Querying the data lake for the last {args.days} days (cached days are skipped)…", flush=True)
        counts, totals = from_lake(args.days, refresh=args.refresh)
        assets, source = fetch_heroes(), {"source": "deadlock-api data lake", "days": args.days}

    curves, index, heroes = build(counts, totals, assets, source)
    names = {h["id"]: h["name"] for h in heroes}
    allx = index[(index["queue"] == "all") & (index["rank"] == "all") & (index["period"] == "all")]
    print(f"{int(totals['matches'].sum()):,} matches, {len(heroes)} heroes, "
          f"{len(curves):,} curve rows, {len(index):,} index rows")
    print("Most early-game:", ", ".join(allx.head(5)["hero_id"].map(names)))
    print("Most late-game: ", ", ".join(allx.tail(5)["hero_id"].map(names)[::-1]))
    print(f"Wrote {C.DATA_DIR}")


if __name__ == "__main__":
    main()
