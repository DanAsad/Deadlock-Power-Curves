"""Item effects (pipeline/items.py): the adjustment must remove the "bought by the team
that was ahead" advantage and keep a real one. Run: python -m pytest pipeline/tests"""
import numpy as np
import pandas as pd

from pipeline.items import effects


def _world(rng, n=400_000):
    """Player-snapshots with a win chance that rises with the team soul lead, plus two items:
    item 1 is only bought when ahead and does nothing; item 2 is bought anywhere and adds 5 points."""
    lead = rng.integers(-10, 11, n) * 2                     # lead bins, % of souls
    bucket = rng.integers(0, 8, n)
    hero = rng.integers(1, 6, n)
    hero_edge = np.array([0, 0.03, -0.03, 0.0, 0.02, -0.02])[hero]
    p = np.clip(0.5 + 0.02 * lead + hero_edge, 0.02, 0.98)
    won = rng.random(n) < p
    base = pd.DataFrame({"item_id": 0, "hero_id": hero, "bucket": bucket, "lead_bin": lead, "won": won})
    rows = [base]
    ahead = lead >= 6                                       # item 1: only the side already ahead buys it
    rows.append(base[ahead].assign(item_id=1))
    pick = rng.random(n) < 0.3                              # item 2: anyone, with a real +5 points
    w2 = rng.random(pick.sum()) < np.clip(p[pick] + 0.05, 0, 1)
    rows.append(base[pick].assign(item_id=2, won=w2))
    df = pd.concat(rows, ignore_index=True)
    return df.groupby(["item_id", "hero_id", "bucket", "lead_bin"]).agg(n=("won", "size"), wins=("won", "sum")).reset_index()


def test_adjustment_removes_game_state_and_keeps_real_effect():
    rng = np.random.default_rng(7)
    out = effects(_world(rng))
    o = out[out["bucket"] == -1].set_index("item_id")
    raw1 = (o.loc[1, "win_rate"] - 0.5) * 100
    assert raw1 > 15                                        # looks great before the adjustment
    assert abs(o.loc[1, "effect"]) < 1                      # nothing left after it
    assert o.loc[1, "ci_low"] < 0 < o.loc[1, "ci_high"]
    assert abs(o.loc[2, "effect"] - 5) < 1                  # the real effect survives
    assert o.loc[2, "ci_low"] > 3


def test_timing_rows_per_bucket():
    rng = np.random.default_rng(8)
    out = effects(_world(rng, n=200_000))
    t = out[(out["item_id"] == 2) & (out["bucket"] >= 0)]
    assert set(t["bucket"]) == set(range(8))
    assert (t["effect"].sub(5).abs() < 3).all()


def test_own_souls_remove_the_rich_buyer_bias():
    """An expensive item that does nothing, bought only by players well above the match's
    average souls: the team lead alone leaves a fake edge; adding the buyer's own souls removes it."""
    rng = np.random.default_rng(9)
    n = 400_000
    lead = rng.integers(-10, 11, n) * 2
    own = rng.integers(-3, 4, n) * 15                       # own-souls bins, % vs the match average
    bucket = rng.integers(0, 8, n)
    hero = rng.integers(1, 6, n)
    p = np.clip(0.5 + 0.02 * lead + 0.003 * own, 0.02, 0.98)
    won = rng.random(n) < p
    base = pd.DataFrame({"item_id": 0, "hero_id": hero, "bucket": bucket, "lead_bin": lead, "own_bin": own, "won": won})
    rich = base[own >= 30].assign(item_id=3)
    df = pd.concat([base, rich], ignore_index=True)
    rows = df.groupby(["item_id", "hero_id", "bucket", "lead_bin", "own_bin"]).agg(n=("won", "size"), wins=("won", "sum")).reset_index()
    o = effects(rows).query("bucket == -1").set_index("item_id")
    assert o.loc[3, "effect_team"] > 5                      # team lead only: looks good
    assert abs(o.loc[3, "effect"]) < 1                      # with own souls: nothing left
    assert o.loc[3, "own"] > 30


def test_compact_layout_matches_detailed():
    """The cache stores purchases as item x state plus item x hero x minute (see items.DAY);
    the results must equal those from one row per item x hero x state."""
    from pipeline.items import ALL_BINS
    rng = np.random.default_rng(10)
    d = _world(rng, n=100_000).assign(own_bin=lambda x: (x["hero_id"] % 3 - 1) * 15)
    base, it = d[d["item_id"] == 0], d[d["item_id"] != 0]
    by_state = it.groupby(["item_id", "bucket", "lead_bin", "own_bin"], as_index=False)[["n", "wins"]].sum().assign(hero_id=-1)
    by_hero = it.groupby(["item_id", "hero_id", "bucket"], as_index=False)[["n", "wins"]].sum().assign(lead_bin=ALL_BINS, own_bin=ALL_BINS)
    compact = pd.concat([base, by_state, by_hero], ignore_index=True)
    a = effects(d).sort_values(["item_id", "bucket"]).reset_index(drop=True)
    b = effects(compact).sort_values(["item_id", "bucket"]).reset_index(drop=True)
    for c in ["n", "wins", "expected", "effect", "effect_team", "lead", "own"]:
        assert np.allclose(a[c], b[c]), c
