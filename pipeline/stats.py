"""Win-rate statistics on aggregated counts (one row per hero x length bucket)."""
import numpy as np
import pandas as pd

from pipeline.config import BIN_LABELS, BIN_MIDS, MIN_BINS_FOR_INDEX, MIN_GAMES_PER_BIN

Z95 = 1.959964


def wilson(wins, n, z=Z95):
    """Wilson score interval for a binomial proportion."""
    wins, n = np.asarray(wins, float), np.asarray(n, float)
    p = wins / n
    denom = 1 + z**2 / n
    centre = (p + z**2 / (2 * n)) / denom
    half = z * np.sqrt(p * (1 - p) / n + z**2 / (4 * n**2)) / denom
    return centre - half, centre + half


def power_curves(counts: pd.DataFrame, keys=("hero_id",)) -> pd.DataFrame:
    """counts: columns [*keys, bucket_idx, wins, games] -> one row per bucket
    with win rate, 95% Wilson CI and whether it clears the min-games threshold."""
    keys = list(keys)
    t = counts.groupby(keys + ["bucket_idx"], as_index=False)[["wins", "games"]].sum()
    t["bucket"] = t["bucket_idx"].map(dict(enumerate(BIN_LABELS)))
    t["mid_min"] = t["bucket_idx"].map(dict(enumerate(BIN_MIDS))).astype(float)
    t["win_rate"] = t["wins"] / t["games"]
    t["ci_low"], t["ci_high"] = wilson(t["wins"], t["games"])
    t["enough"] = t["games"] >= MIN_GAMES_PER_BIN
    return t.sort_values(keys + ["bucket_idx"]).reset_index(drop=True)


def _wls_slope(x, p, n):
    """Inverse-variance weighted slope of win rate on minutes, with its SE."""
    var = np.clip(p * (1 - p), 1e-4, None) / n
    w = 1 / var
    xbar = np.sum(w * x) / np.sum(w)
    sxx = np.sum(w * (x - xbar) ** 2)
    slope = np.sum(w * (x - xbar) * p) / sxx
    return slope, np.sqrt(1 / sxx)


def scaling_index(curves: pd.DataFrame, keys=("hero_id",)) -> pd.DataFrame:
    """Percentage points of win rate gained per extra 10 minutes of game length,
    fit only on buckets with enough games. + = late-game, - = early-game."""
    keys = list(keys)
    rows = []
    for k, g in curves[curves["enough"]].groupby(keys):
        if len(g) < MIN_BINS_FOR_INDEX:
            continue
        slope, se = _wls_slope(g["mid_min"].to_numpy(), g["win_rate"].to_numpy(), g["games"].to_numpy())
        k = k if isinstance(k, tuple) else (k,)
        rows.append((*k, slope * 1000, (slope - Z95 * se) * 1000, (slope + Z95 * se) * 1000))
    idx = pd.DataFrame(rows, columns=keys + ["pp_per_10min", "ci_low", "ci_high"])

    totals = curves.groupby(keys, as_index=False)[["wins", "games"]].sum()
    totals["win_rate"] = totals["wins"] / totals["games"]
    totals["wr_ci_low"], totals["wr_ci_high"] = wilson(totals["wins"], totals["games"])
    return idx.merge(totals, on=keys, how="left").sort_values(keys[:-1] + ["pp_per_10min"]).reset_index(drop=True)
