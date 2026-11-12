"""Run: python -m pytest pipeline/tests"""
import numpy as np
import pandas as pd

from pipeline.build import KEYS, expand_slices
from pipeline.demo import make_demo
from pipeline.extract import from_frame
from pipeline.stats import power_curves, scaling_index, wilson


def test_wilson_contains_p_and_shrinks():
    lo, hi = wilson(np.array([50, 500]), np.array([100, 1000]))
    assert np.all(lo < 0.5) and np.all(hi > 0.5)
    assert (hi[1] - lo[1]) < (hi[0] - lo[0])
    lo0, _ = wilson(0, 10)                       # stays inside [0, 1] at the edge
    assert lo0 >= -1e-12


def test_demo_recovers_planted_scaling():
    """The index must recover the per-hero slopes planted in synthetic data."""
    df = make_demo()
    counts, _ = from_frame(df)
    curves = power_curves(counts.groupby(["hero_id", "bucket_idx"], as_index=False)[["wins", "games"]].sum())
    idx = scaling_index(curves).set_index("hero_id")
    true = pd.Series(df.attrs["true_slope"])[idx.index]
    r = np.corrcoef(idx["pp_per_10min"], true)[0, 1]
    assert r > 0.95, f"recovered vs true scaling correlation {r:.2f}"
    # CI should cover ~95%; just require it's not obviously broken
    assert (idx["ci_low"] < idx["pp_per_10min"]).all() and (idx["ci_high"] > idx["pp_per_10min"]).all()


def test_adjusted_index_ignores_hero_strength():
    """Heroes with no real scaling, only different strength, in games where short = stomp:
    the plain slope calls strong heroes early-game, the adjusted index must not."""
    mids = np.array([17.5, 22.5, 27.5, 32.5, 37.5, 42.5])
    share = np.array([1.6, 1.4, 1.2, 1.0, 0.7, 0.5])           # how much of the edge shows per bucket
    rows = []
    for h in range(20):
        edge = (h - 9.5) / 200                                  # -4.75pp .. +4.75pp
        late = 0.004 if h == 19 else 0.0                        # one hero truly gains with length
        for b in range(6):
            n = 200_000
            rows.append((h, b, round(n * (0.5 + share[b] * edge + late * (mids[b] - 30) / 10)), n))
    curves = power_curves(pd.DataFrame(rows, columns=["hero_id", "bucket_idx", "wins", "games"]))
    idx = scaling_index(curves).set_index("hero_id")
    flat = idx.drop(index=19)
    assert np.corrcoef(flat["raw_pp_per_10min"], flat["win_rate"])[0, 1] < -0.9
    assert flat["pp_per_10min"].abs().max() < 0.15              # pp per 10 min
    assert idx.loc[19, "pp_per_10min"] > 0.3 and idx["pp_per_10min"].idxmax() == 19


def test_slices_add_up():
    counts, totals = from_frame(make_demo(n_matches=3000))
    s = expand_slices(counts, ["wins", "games"], ["hero_id", "bucket_idx"])
    g = s[s["period"] == "all"].groupby(["queue", "rank"])["games"].sum()   # patch periods repeat the rows
    assert g["all", "all"] == g["ranked", "all"] + g["unranked", "all"] == 3000 * 12
    assert g["ranked", "all"] == sum(g["ranked", r] for r in ("low", "mid", "high"))
    # each match has 6 winners and 6 losers
    assert s.query("queue=='all' and rank=='all' and period=='all'")["wins"].sum() == 3000 * 6
    assert set(KEYS) <= set(power_curves(s, KEYS).columns)
