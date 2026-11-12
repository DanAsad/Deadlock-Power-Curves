"""Model check: held-out evaluation of the team prediction (pipeline/evaluate.py)."""
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

from api.store import DATA_DIR

router = APIRouter(tags=["model check"])
PATH: Path = DATA_DIR / "model_eval.json"
_cache: dict = {"mtime": None, "data": None}


@router.get("/model-eval")
def model_eval():
    """Per split (newest day held out / random 20%) and minute: log loss, Brier,
    accuracy, AUC and calibration for coin flip, souls-only and full models, plus
    drop-one-group tests with 95% CIs."""
    if not PATH.exists():
        raise HTTPException(404, "data/model_eval.json missing: run python -m pipeline.evaluate")
    mtime = PATH.stat().st_mtime
    if mtime != _cache["mtime"]:
        _cache.update(mtime=mtime, data=json.loads(PATH.read_text(encoding="utf-8")))
    return _cache["data"]
