"""Run: python -m pytest pipeline/tests"""
import numpy as np

from pipeline.win_factors import _auc, analyse, logit_fit, make_demo


def test_logit_recovers_coefficients():
    rng = np.random.default_rng(0)
    X = np.column_stack([np.ones(20000), rng.normal(size=(20000, 2))])
    y = (rng.random(20000) < 1 / (1 + np.exp(-(X @ [0.2, 1.0, -0.5])))).astype(float)
    beta, se = logit_fit(X, y)
    assert np.all(np.abs(beta - [0.2, 1.0, -0.5]) < 4 * se)


def test_auc_matches_definition():
    y = np.array([0, 0, 1, 1]); p = np.array([0.1, 0.4, 0.35, 0.8])
    assert abs(_auc(y, p) - 0.75) < 1e-12


def test_demo_ranks_planted_factors():
    """At the last minute, planted factors carry weight; unplanted ones are ~0."""
    df = make_demo(n_matches=20000)
    s = analyse(df)["all|all"]["minutes"][-1]
    eff = {f["id"]: f["effect_pp"] for f in s["factors"] if f["effect_pp"] is not None}
    assert max(eff, key=lambda k: abs(eff[k])) == "souls"
    assert eff["walkers"] > 0 and eff["mid_boss"] > 0
    assert s["metrics"]["accuracy"] > 0.6


def test_correlations_shape_and_symmetry():
    df = make_demo(n_matches=5000)
    m = analyse(df)["all|all"]["minutes"][-1]["corr"]
    n = len(m["vars"])
    assert m["vars"][0] == "won" and len(m["r"]) == n
    for i in range(n):
        for j in range(n):
            a, b = m["r"][i][j], m["r"][j][i]
            assert (a is None and b is None) or abs(a - b) < 1e-9
    i = m["vars"].index("souls")
    assert m["r"][i][i] == 1.0 and m["r"][0][i] > 0.2      # souls lead goes with winning


def test_draft_features_sum_team_priors():
    import pandas as pd
    from pipeline.win_factors import draft_features
    matches = pd.DataFrame({"match_id": [7], "heroes0": [[1, 2]], "heroes1": [[3, 4]]})
    out = draft_features(matches, scale={1: 1.0, 2: 2.0, 3: 0.5}, wr={1: 0.52, 3: 0.49})
    assert abs(out["draft_scaling"][0] - 2.5) < 1e-9        # (1+2) - (0.5+0 unknown)
    assert abs(out["draft_strength"][0] - 3.0) < 1e-9       # (2+0) - (-1+0) pp


def _ph(path, rows):
    import pandas as pd
    pd.DataFrame(rows, columns=["account_id", "hero_id", "n", "wins", "spm"]).to_parquet(path, index=False)


def test_player_features_use_prior_days_only(tmp_path, monkeypatch):
    import pandas as pd
    import pipeline.patches as patches
    import pipeline.win_factors as wf
    monkeypatch.setattr(wf, "CACHE", tmp_path)
    monkeypatch.setattr(patches, "load", lambda refresh=False: [])
    # account 10: 3 games on hero 1 (3 wins); account 20: 100 games on hero 3 (50 wins)
    _ph(tmp_path / "ph_2026-11-08.parquet", [[10, 1, 3, 3, 3 * 900.0], [20, 3, 100, 50, 100 * 700.0]])
    _ph(tmp_path / "ph_2026-11-09.parquet", [[10, 1, 999, 0, 0.0]])   # the match day itself: must be ignored
    matches = pd.DataFrame({"match_id": [5], "heroes0": [[1, 2]], "heroes1": [[3, 4]],
                            "accounts0": [[10, 11]], "accounts1": [[20, 21]]})
    days = pd.Series([pd.Timestamp("2026-11-09")], index=pd.Index([5], name="match_id"))
    out = wf.player_features(matches, days).iloc[0]
    assert abs(out["hero_experience"] - (1.5 - 25.0)) < 1e-9          # mean(3,0) - mean(cap 50,0)
    form10 = ((3 + 10) / (3 + 20) - 0.5) * 100                        # pulled toward 50%
    assert abs(out["player_form"] - (form10 / 2 - 0.0)) < 1e-9        # account 20 is exactly 50%
    avg = (3 * 900 + 100 * 700) / 103
    farm10, farm20 = (3 * 900 + 5 * avg) / 8, (100 * 700 + 5 * avg) / 105
    assert abs(out["player_farm"] - ((farm10 + avg) / 2 - (farm20 + avg) / 2)) < 1e-6
    assert out["hero_mastery"] > 0                                    # 3/3 on the picked hero


def test_pair_effects_recover_synergy_and_counter():
    import pandas as pd
    from pipeline.win_factors import pair_effects, pair_features
    # heroes 1 and 2 win 60% together; hero 1 beats hero 3 55% of the time; all else even
    pairs = pd.DataFrame({"h1": [1, 1, 2, 1, 3], "h2": [2, 3, 3, 4, 4], "same": [True, False, False, False, False],
                          "n": [10000, 10000, 10000, 10000, 10000], "wins": [6000, 5500, 5000, 5000, 5000]})
    S, C = pair_effects(pairs, prior=0)
    assert S[1, 2] == S[2, 1] and S[1, 2] > 0.05
    assert C[1, 3] > 0 and abs(C[1, 3] + C[3, 1]) < 1e-12
    m = pd.DataFrame({"match_id": [1], "heroes0": [[1, 2]], "heroes1": [[3, 4]]})
    f = pair_features(m, S, C).iloc[0]
    assert f["draft_synergy"] > 5
    swapped = pair_features(m.rename(columns={"heroes0": "heroes1", "heroes1": "heroes0"}), S, C).iloc[0]
    assert abs(f["draft_synergy"] + swapped["draft_synergy"]) < 1e-9
    assert abs(f["draft_counter"] + swapped["draft_counter"]) < 1e-9


def test_patch_cuts_history_window_only_when_old_enough():
    from datetime import date
    from pipeline.patches import history_start, parse
    assert parse([{"title": "09-29-2026 Update"}, {"title": "junk"}, {"title": "09-16-2026"}]) == ["2026-09-16", "2026-09-29"]
    assert history_start(date(2026, 11, 10), 30, ["2026-09-29"]) == date(2026, 10, 11)   # patch before the window
    assert history_start(date(2026, 11, 10), 30, ["2026-10-25"]) == date(2026, 10, 25)   # 16 days on the patch
    assert history_start(date(2026, 11, 10), 30, ["2026-11-07"]) == date(2026, 10, 11)   # too new: keep 30 days
