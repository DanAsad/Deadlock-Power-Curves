"""Run: python -m pytest pipeline/tests"""
import numpy as np
import pandas as pd

from pipeline.evaluate import ece, evaluate_minute, splits
from pipeline.win_factors import make_demo


def test_time_split_holds_out_newest_day_and_never_mixes_matches():
    df = make_demo(n_matches=3000)
    df["day"] = pd.Timestamp("2026-01-01") + pd.to_timedelta(df["match_id"] % 3, "D")
    for tr, te, _ in splits(df).values():
        assert not set(df.loc[tr, "match_id"]) & set(df.loc[te, "match_id"])
    tr, te, info = splits(df)["time"]
    assert df.loc[te, "day"].nunique() == 1 and df.loc[te, "day"].iloc[0] == df["day"].max()


def test_full_model_beats_baselines_and_souls_group_matters():
    df = make_demo(n_matches=20000)
    d = df[df["minute"] == 40]
    te = d["match_id"] % 5 == 0
    r = evaluate_minute(d[~te], d[te])
    m = r["models"]
    assert m["full"]["log_loss"] < m["coin"]["log_loss"]
    assert m["full"]["log_loss"] <= m["souls_only"]["log_loss"] + 1e-3
    econ = next(a for a in r["ablation"] if a["group"] == "economy")   # souls live here
    assert econ["ci_low"] > 0


def test_ece_is_zero_when_perfectly_calibrated():
    assert ece([{"n": 10, "observed": 0.3, "mean_pred": 0.3}, {"n": 5, "observed": 0.8, "mean_pred": 0.8}]) == 0
