"""Best partners and counters per hero, from the hero-pair counts cached by the
win-model pipeline (data/cache/hp_<day>.parquet: per pair of heroes, on the same
team or on opposite teams, games and wins of the first hero's side).

For a pair, the *expected* win rate comes from the two heroes' own win rates in
the same matches (with: 50% + edge(a) + edge(b); against: 50% + edge(a) - edge(b)).
The *effect* is the observed win rate minus that, in percentage points:
  with     +2 = the two win 2 points more often together than their own strength suggests
  against  +2 = hero a's side beats hero b's side 2 points more often than expected
Shown with a 95% CI (binomial, on the observed rate). Ranked by the effect
shrunk toward 0 by PAIR_PRIOR pseudo-games (the same shrinkage the win model's
draft factors use), so a small, noisy pair does not top the list.

  python -m pipeline.hero_pairs        # writes data/hero_pairs.parquet
"""
import json

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline.stats import Z95
from pipeline.win_factors import CACHE, HISTORY_DAYS, PAIR_PRIOR

MIN_PAIR_GAMES = 1000                          # pairs with fewer games are not shown


def load(days: int = HISTORY_DAYS) -> tuple[pd.DataFrame, list[str]]:
    files = sorted(CACHE.glob("hp_*.parquet"))[-days:]
    if not files:
        raise SystemExit("no hero-pair caches in data/cache (they come from python -m pipeline.evaluate)")
    pairs = pd.concat([pd.read_parquet(f) for f in files]).groupby(["h1", "h2", "same"], as_index=False)[["n", "wins"]].sum()
    return pairs, [files[0].stem[3:], files[-1].stem[3:]]


def table(pairs: pd.DataFrame, prior: float = PAIR_PRIOR) -> pd.DataFrame:
    """One row per (hero, other hero, with/against), from the hero's point of view."""
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
    return t[cols].astype({"hero": "int16", "other": "int16", "n": "int64"}).sort_values(["hero", "kind", "shrunk"],
                                                                                          ascending=[True, True, False]).reset_index(drop=True)


def main():
    pairs, span = load()
    t = table(pairs)
    t.to_parquet(C.DATA_DIR / "hero_pairs.parquet", index=False)
    (C.DATA_DIR / "hero_pairs.json").write_text(json.dumps({"first_day": span[0], "last_day": span[1],
                                                            "min_games": MIN_PAIR_GAMES, "prior": PAIR_PRIOR}), encoding="utf-8")
    print(f"{len(t):,} hero-pair rows from {span[0]} to {span[1]} ({t['hero'].nunique()} heroes); "
          f"effects {t['effect'].min():.1f} to {t['effect'].max():.1f} pp")
    print(f"Wrote {C.DATA_DIR / 'hero_pairs.parquet'}")


if __name__ == "__main__":
    main()
