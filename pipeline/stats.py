"""Win-rate statistics on aggregated counts (one row per hero x length bucket)."""
import numpy as np
import pandas as pd

from pipeline.config import BIN_LABELS, BIN_MIDS, MIN_BINS_FOR_INDEX, MIN_GAMES_PER_BIN, MIN_HEROES_FOR_ADJUST

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


def _wls_slope(x, p, n, y=None):
    """Inverse-variance weighted slope of y (default: the win rate p) on minutes, with its SE."""
    y = p if y is None else y
    var = np.clip(p * (1 - p), 1e-4, None) / n
    w = 1 / var
    xbar = np.sum(w * x) / np.sum(w)
    sxx = np.sum(w * (x - xbar) ** 2)
    slope = np.sum(w * (x - xbar) * y) / sxx
    return slope, np.sqrt(1 / sxx)


def strength_by_bucket(ok: pd.DataFrame, slice_keys: list[str]) -> pd.DataFrame:
    """How much of a hero's overall edge shows up in each length bucket.

    Short games are stomps, and the stronger side wins stomps, so every strong
    hero looks "early-game" and every weak one "late-game". Per slice and
    bucket this fits, across heroes, (bucket win rate - 50%) = share x
    (overall win rate - 50%), weighted by games. share > 1 in short games and
    < 1 in long ones is that stomp effect; it is the same for every hero."""
    def fit(g):
        den = np.sum(g["games"] * g["edge"] ** 2)
        if len(g) < MIN_HEROES_FOR_ADJUST or den <= 0:
            return 1.0
        return float(np.sum(g["games"] * g["edge"] * (g["win_rate"] - 0.5)) / den)
    by = slice_keys + ["bucket_idx"]
    rows = [(*(k if isinstance(k, tuple) else (k,)), fit(g)) for k, g in ok.groupby(by)]
    return pd.DataFrame(rows, columns=by + ["strength_share"])


def scaling_index(curves: pd.DataFrame, keys=("hero_id",)) -> pd.DataFrame:
    """Percentage points of win rate gained per extra 10 minutes of game length,
    fit only on buckets with enough games. + = late-game, - = early-game.

    pp_per_10min / ci_*: adjusted for hero strength. The slope is fit on what
    is left of each bucket's win rate after removing the part explained by the
    hero's overall win rate (see strength_by_bucket). The CI ignores the small
    uncertainty in the shared per-bucket shares.
    raw_pp_per_10min / raw_ci_*: the plain slope through the power curve.
    The last key is the hero; the keys before it define the slice."""
    keys = list(keys)
    totals = curves.groupby(keys, as_index=False)[["wins", "games"]].sum()
    totals["win_rate"] = totals["wins"] / totals["games"]
    totals["wr_ci_low"], totals["wr_ci_high"] = wilson(totals["wins"], totals["games"])

    ok = curves[curves["enough"]].merge(totals[keys + ["win_rate"]].rename(columns={"win_rate": "hero_wr"}), on=keys)
    ok["edge"] = ok["hero_wr"] - 0.5
    ok = ok.merge(strength_by_bucket(ok, keys[:-1]), on=keys[:-1] + ["bucket_idx"])
    ok["resid"] = ok["win_rate"] - 0.5 - ok["strength_share"] * ok["edge"]

    rows = []
    for k, g in ok.groupby(keys):
        if len(g) < MIN_BINS_FOR_INDEX:
            continue
        x, p, n = g["mid_min"].to_numpy(), g["win_rate"].to_numpy(), g["games"].to_numpy()
        raw, se = _wls_slope(x, p, n)
        adj, _ = _wls_slope(x, p, n, g["resid"].to_numpy())
        k = k if isinstance(k, tuple) else (k,)
        rows.append((*k, *(v * 1000 for v in (adj, adj - Z95 * se, adj + Z95 * se, raw, raw - Z95 * se, raw + Z95 * se))))
    idx = pd.DataFrame(rows, columns=keys + ["pp_per_10min", "ci_low", "ci_high",
                                             "raw_pp_per_10min", "raw_ci_low", "raw_ci_high"])
    return idx.merge(totals, on=keys, how="left").sort_values(keys[:-1] + ["pp_per_10min"]).reset_index(drop=True)
