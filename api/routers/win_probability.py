"""Phase 2: win-probability graph per match (pipeline/win_probability.py).

GET /win-probability             example matches (summaries)
GET /win-probability/{match_id}  one match: win chance per minute plus events

Example matches are precomputed in data/win_probability.json. Any other match
id is looked up in the data lake and scored on the spot; that needs the
pipeline's dependencies and the saved models, so it only works where the full
project is installed (not on the static site).
"""
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

from api.store import DATA_DIR

router = APIRouter(tags=["win probability"])
PATH: Path = DATA_DIR / "win_probability.json"
_cache: dict = {"mtime": None, "data": None}
_computed: dict[int, dict] = {}          # matches scored on demand, kept for this process


def _load() -> dict:
    if not PATH.exists():
        raise HTTPException(404, "data/win_probability.json missing: run python -m pipeline.win_probability")
    mtime = PATH.stat().st_mtime
    if mtime != _cache["mtime"]:
        _cache.update(mtime=mtime, data=json.loads(PATH.read_text(encoding="utf-8")))
    return _cache["data"]


def _summary(m: dict) -> dict:
    p = [x["p"] if m["winner"] == 0 else 1 - x["p"] for x in m["points"]]
    return {**{k: v for k, v in m.items() if k not in ("points", "events")},
            "lowest_winner_chance": min(p) if p else None}


@router.get("/win-probability")
def matches():
    d = _load()
    return {"generated_at": d["generated_at"], "model": d["model"], "max_minute": d["max_minute"],
            "lookup": True, "matches": [_summary(m) for m in d["matches"]]}


@router.get("/win-probability/{match_id}")
def match(match_id: int):
    d = _load()
    found = next((m for m in d["matches"] if m["match_id"] == match_id), None) or _computed.get(match_id)
    if found is None:
        try:
            from pipeline.win_probability import build
            built = build([match_id])
        except HTTPException:
            raise
        except Exception as e:             # no lake access, missing model files, ...
            raise HTTPException(503, f"could not score match {match_id}: {str(e).splitlines()[0][:160]}")
        if not built:
            raise HTTPException(404, f"match {match_id} not found in the data lake as a complete, scored 6v6 game "
                                     "(very recent matches take about an hour to appear)")
        found = _computed[match_id] = built[0]
    return {"model": d["model"], "max_minute": d["max_minute"], "match": found}
