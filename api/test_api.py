"""Run: python -m pytest api (needs ./data; build it with python -m pipeline.build --demo)."""
import pytest

testclient = pytest.importorskip("starlette.testclient", exc_type=RuntimeError,
                                 reason="starlette test client needs its HTTP client package")
TestClient = testclient.TestClient

from api.main import app

c = TestClient(app)


def test_endpoints():
    m = c.get("/api/meta").json()
    assert m["filters"]["queue"][0]["id"] == "all"
    h = c.get("/api/heroes").json()["heroes"]
    assert h and "win_rate" in h[0]
    pc = c.get("/api/power-curves", params={"hero_id": h[0]["id"]}).json()["curves"]
    assert len(pc) == 1 and pc[0]["points"]
    si = c.get("/api/scaling-index", params={"queue": "ranked"}).json()["heroes"]
    assert si == sorted(si, key=lambda r: r["pp_per_10min"])


def test_rank_needs_ranked_queue():
    assert c.get("/api/scaling-index", params={"rank": "high"}).status_code == 422
    assert c.get("/api/scaling-index", params={"queue": "ranked", "rank": "high"}).status_code == 200
    assert c.get("/api/scaling-index", params={"queue": "bogus"}).status_code == 422
