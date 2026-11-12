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


def test_slices_add_up():
    counts, totals = from_frame(make_demo(n_matches=3000))
    s = expand_slices(counts, ["wins", "games"], ["hero_id", "bucket_idx"])
    g = s[s["period"] == "all"].groupby(["queue", "rank"])["games"].sum()   # patch periods repeat the rows
    assert g["all", "all"] == g["ranked", "all"] + g["unranked", "all"] == 3000 * 12
    assert g["ranked", "all"] == sum(g["ranked", r] for r in ("low", "mid", "high"))
    # each match has 6 winners and 6 losers
    assert s.query("queue=='all' and rank=='all' and period=='all'")["wins"].sum() == 3000 * 6
    assert set(KEYS) <= set(power_curves(s, KEYS).columns)
