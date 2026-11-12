"""Run: python -m pytest pipeline/tests"""
import pandas as pd

from pipeline.win_probability import _events


def test_events_credit_the_team_that_destroyed_the_objective():
    objectives = pd.DataFrame({"name": ["Tier1Lane1", "Tier2Lane3", "Titan", "Tier1Lane4"],
                               "owner": ["Team1", "Team0", "Team1", "Team0"], "t": [400, 900, 1500, 0]})
    boss = pd.DataFrame({"team": ["Team1"], "t": [1200]})
    ev = _events(objectives, boss)
    assert [e["t"] for e in ev] == [400, 900, 1200, 1500]            # sorted; never-destroyed (t = 0) dropped
    assert ev[0] == {"t": 400, "kind": "guardian", "label": "Guardian", "by": 0}   # Team1's Guardian fell to team 0
    assert ev[1]["kind"] == "walker" and ev[1]["by"] == 1
    assert ev[2] == {"t": 1200, "kind": "mid_boss", "label": "Mid-Boss claimed", "by": 1}
    assert ev[3]["kind"] == "patron" and ev[3]["by"] == 0
