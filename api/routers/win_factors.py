"""What wins games: factor weights by game minute (pipeline/win_factors.py)."""
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

from api.routers.power_curves import SliceDep
from api.store import DATA_DIR

router = APIRouter(tags=["win factors"])
PATH: Path = DATA_DIR / "win_factors.json"
_cache: dict = {"mtime": None, "data": None}


def _load() -> dict:
    if not PATH.exists():
        raise HTTPException(404, "data/win_factors.json missing: run python -m pipeline.win_factors")
    mtime = PATH.stat().st_mtime
    if mtime != _cache["mtime"]:
        _cache.update(mtime=mtime, data=json.loads(PATH.read_text(encoding="utf-8")))
    return _cache["data"]


@router.get("/win-factors")
def win_factors(s: SliceDep):
    """Per snapshot minute: each factor's unique weight (logistic regression,
    95% CI), how often the team ahead in it wins, and held-out model metrics.
    Fit on all patches in the window, so the patch filter is not applied."""
    d = _load()
    sl = d["slices"].get(f"{s.queue}|{s.rank}")
    return {
        "slice": s, "period_applied": False,
        "generated_at": d["generated_at"], "source": d["source"], "days": d["days"],
        "factors": d["factors"], "min_matches": d["min_matches"],
        "data": sl,
    }
