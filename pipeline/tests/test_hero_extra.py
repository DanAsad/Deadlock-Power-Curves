"""Hero partners/counters (pipeline/hero_pairs.py) and strength at each minute
(pipeline/at_minute.py). Run: python -m pytest pipeline/tests"""
import numpy as np
import pandas as pd

from pipeline.at_minute import summarise
from pipeline.hero_pairs import table
from pipeline.win_factors import pair_effects


def _pairs(rng, heroes=8, n=50_000, strength=None, planted=None):
    """Pair counts for random 6v6 drafts with given hero strengths and planted pair effects."""
    strength = strength if strength is not None else np.zeros(heroes)
    planted = planted or {}
    rows = {}
    for _ in range(n):
        h = rng.permutation(heroes)[:6] if heroes >= 6 else rng.permutation(heroes)
        t0, t1 = sorted(h[:3]), sorted(h[3:6])
        p = 0.5 + strength[t0].sum() - strength[t1].sum()
        for team, sgn in ((t0, 1), (t1, -1)):
            for i in range(len(team)):
                for j in range(i + 1, len(team)):
                    p += sgn * planted.get((team[i], team[j]), 0.0)
        won0 = rng.random() < p
        for a in h[:6]:
            for b in h[:6]:
                if a >= b:
                    continue
                same = (a in t0) == (b in t0)
                a_won = won0 if a in t0 else not won0
                k = (a, b, same)
                n_, w_ = rows.get(k, (0, 0))
                rows[k] = (n_ + 1, w_ + int(a_won))
    return pd.DataFrame([(a, b, s, n_, w_) for (a, b, s), (n_, w_) in rows.items()], columns=["h1", "h2", "same", "n", "wins"])


def test_pairs_find_planted_synergy_and_match_model():
    rng = np.random.default_rng(1)
    pairs = _pairs(rng, strength=np.linspace(-0.02, 0.02, 8), planted={(1, 2): 0.06})
    t = table(pairs, prior=0)
    w = t[t["kind"] == "with"]
    best = w.sort_values("effect", ascending=False).iloc[0]
    assert {int(best["hero"]), int(best["other"])} == {1, 2}           # the planted pair comes out on top
    assert best["ci_low"] > 0
    # with no planted effect, strength alone gives effects near zero
    others = w[~(w["hero"].isin([1, 2]) & w["other"].isin([1, 2]))]
    assert others["effect"].abs().median() < 1.5
    # same numbers as the win model's draft factors (shrunk the same way)
    t2 = table(pairs)
    S, C = pair_effects(pairs)
    x = t2[t2["kind"] == "with"]
    assert np.allclose(x["shrunk"] / 100, S[x["hero"], x["other"]])
    g = t2[t2["kind"] == "against"]
    assert np.allclose(g["shrunk"] / 100, C[g["hero"], g["other"]])


def test_against_is_mirrored():
    rng = np.random.default_rng(2)
    t = table(_pairs(rng, n=20_000), prior=0)
    g = t[t["kind"] == "against"].set_index(["hero", "other"])["effect"]
    back = g.copy(); back.index = back.index.swaplevel()
    assert np.allclose(g, -back.reindex(g.index))


def test_at_minute_means_and_ci():
    rng = np.random.default_rng(3)
    lead = rng.normal(1.5, 4, 5000)
    share = rng.normal(-3, 10, 5000)
    sums = pd.DataFrame([{"day": pd.Timestamp("2026-11-01"), "hero_id": 7, "queue": "Ranked", "rank": "mid", "minute": 12,
                          "n": len(lead), "s_lead": lead.sum(), "ss_lead": (lead ** 2).sum(),
                          "s_share": share.sum(), "ss_share": (share ** 2).sum()}])
    out = summarise(sums)
    r = out[(out["queue"] == "all") & (out["rank"] == "all") & (out["period"] == "all")].iloc[0]
    assert abs(r["lead"] - lead.mean()) < 1e-9 and abs(r["share"] - share.mean()) < 1e-9
    half = 1.959964 * lead.std() / np.sqrt(len(lead))
    assert abs((r["lead_high"] - r["lead_low"]) / 2 - half) < 1e-6
    assert bool(r["enough"])
    assert set(out["queue"]) == {"all", "ranked"}                     # no unranked rows from ranked-only data
