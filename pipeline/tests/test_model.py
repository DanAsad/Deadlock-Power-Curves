"""Run: python -m pytest pipeline/tests"""
import numpy as np

from pipeline.model import CONTEXT, LIVE_DIFFS, WinModel
from pipeline.win_factors import make_demo


def _fit(diffs=None):
    df = make_demo(n_matches=8000)
    df["total_souls"] = 20000.0 + df["minute"] * 3000
    calib = df["match_id"] % 10 == 7
    test = df["match_id"] % 10 == 0
    m = WinModel(diffs=diffs, max_iter=60).fit(df[~calib & ~test], df[calib])
    return m, df[test]


def test_symmetric_in_teams():
    m, test = _fit()
    X = test.copy()
    p = m.predict_raw(X)
    for c in m.diffs:
        X[c] = -X[c]
    q = m.predict_raw(X)
    assert np.allclose(p + q, 1, atol=1e-6)


def test_monotone_in_souls_and_better_than_coin():
    m, test = _fit()
    t = test[test["minute"] == 20].head(200).copy()
    lo, hi = t.copy(), t.copy()
    hi["souls"] += 5000
    assert (m.predict_raw(hi) >= m.predict_raw(lo) - 1e-9).all()
    y = test["team0_won"].to_numpy(float)
    p = m.predict(test)
    ll = -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
    assert ll < np.log(2) - 0.02


def test_flip_negates_only_team_columns():
    df = make_demo(n_matches=50)
    df["total_souls"] = 1000.0
    m = WinModel()
    X = m.features(df)
    F = m.flip(X)
    for c in CONTEXT:
        i = m.feats.index(c)
        assert np.array_equal(F[:, i], X[:, i])
    i = m.feats.index("souls")
    assert np.array_equal(F[:, i], -X[:, i])


def test_linear_score_interpolates_between_minutes():
    m, test = _fit()
    t = test[test["minute"] == 15].head(50).copy()
    a, b, mid = t.copy(), t.copy(), t.copy()
    a["minute"], b["minute"], mid["minute"] = 12.0, 14.0, 13.0
    assert np.allclose(m.linear(mid), (m.linear(a) + m.linear(b)) / 2)
    assert "souls" in m.info()["constrained"]


def test_live_model_ignores_fields_the_live_api_lacks():
    m, test = _fit(LIVE_DIFFS)
    t = test.head(300).copy()
    p = m.predict(t)
    t["kills"] += 50                      # kills are not in the live API
    assert np.array_equal(p, m.predict(t))
    assert "kills" not in m.feats and "souls" in m.feats


def test_staleness_is_minutes_since_last_snapshot():
    from pipeline.model import staleness
    assert staleness(np.array([1, 3, 4, 15, 19, 20, 44, 45])).tolist() == [1, 0, 1, 0, 4, 0, 4, 0]


def test_rank_gap_only_counts_in_ranked_matches():
    m, test = _fit()
    t = test.head(400).copy()
    t["queue"] = "Unranked"
    p = m.predict_raw(t)
    t["rank_gap"] = 5.0
    assert np.array_equal(p, m.predict_raw(t))
