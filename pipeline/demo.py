"""Synthetic 6v6 matches with known per-hero scaling, to check the pipeline
recovers what was planted (see tests/test_recovery.py)."""
import numpy as np
import pandas as pd


def make_demo(n_matches: int = 40_000, n_heroes: int = 36, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    base = rng.normal(0, 0.10, n_heroes)        # flat strength (log-odds)
    slope = rng.normal(0, 0.12, n_heroes)       # per 10 min, + = late-game

    heroes = np.argsort(rng.random((n_matches, n_heroes)), axis=1)[:, :12]
    dur_min = np.clip(rng.gamma(9, 4.0, n_matches), 12, 75)
    x = ((dur_min - 35) / 10)[:, None]
    strength = base[heroes] + slope[heroes] * x
    diff = strength[:, :6].sum(1) - strength[:, 6:].sum(1)
    team0_won = rng.random(n_matches) < 1 / (1 + np.exp(-diff))

    ranked = rng.random(n_matches) < 0.3
    badge = np.where(ranked, rng.integers(11, 117, n_matches), 0)
    start = pd.Timestamp.now(tz="UTC").floor("s") - pd.to_timedelta(rng.uniform(0, 30 * 86400, n_matches), "s")

    won = np.concatenate([np.repeat(team0_won[:, None], 6, 1), np.repeat(~team0_won[:, None], 6, 1)], 1)
    df = pd.DataFrame({
        "match_id": np.repeat(np.arange(n_matches), 12),
        "hero_id": heroes.ravel() + 1,
        "won": won.ravel(),
        "duration_s": np.repeat(dur_min * 60, 12).astype(int),
        "start_time": np.repeat(start, 12),
        "queue": np.repeat(np.where(ranked, "Ranked", "Unranked"), 12),
        "average_badge": np.repeat(np.where(ranked, badge, np.nan), 12),
    })
    df.attrs["true_slope"] = dict(zip(range(1, n_heroes + 1), slope))
    return df
