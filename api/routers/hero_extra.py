"""Hero state at each game minute (pipeline/at_minute.py) and hero partners and
counters (pipeline/hero_pairs.py)."""
import json
from typing import Annotated

import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from api.routers.power_curves import SliceDep, _pick, _records, _sample
from api.store import DATA_DIR

router = APIRouter(tags=["heroes"])
_cache: dict = {}


def _table(name: str, hint: str) -> pd.DataFrame:
    f = DATA_DIR / f"{name}.parquet"
    if not f.exists():
        raise HTTPException(404, f"data/{name}.parquet missing: run {hint}")
    mtime = f.stat().st_mtime
    if _cache.get(name, (None,))[0] != mtime:
        _cache[name] = (mtime, pd.read_parquet(f))
    return _cache[name][1]


@router.get("/at-minute")
def at_minute(s: SliceDep, hero_id: Annotated[list[int] | None, Query()] = None):
    """Per hero and snapshot minute: the team's soul lead (% of all souls) and the
    hero's own souls vs the lobby average (%), with 95% CIs. Points under the
    min-games threshold come with enough=false."""
    df = _pick(_table("at_minute", "python -m pipeline.at_minute"), s)
    if hero_id:
        df = df[df["hero_id"].isin(hero_id)]
    cols = ["minute", "n", "lead", "lead_low", "lead_high", "share", "share_low", "share_high", "enough"]
    df = df.round({c: 3 for c in cols[2:8]})
    curves = [{"hero_id": int(h), "points": _records(g.sort_values("minute"), cols)} for h, g in df.groupby("hero_id")]
    return {"slice": s, "sample": _sample(s), "curves": curves}


PAIR_COLS = ["other", "n", "win_rate", "expected", "effect", "ci_low", "ci_high"]


@router.get("/hero-pairs")
def hero_pairs(s: SliceDep):
    """Every hero's partners ("with") and match-ups ("against") in the selected slice:
    effect in percentage points beyond the two heroes' own win rates, 95% CI, games;
    best first. Rows are arrays in the order of `cols` (keeps the static files small)."""
    df = _pick(_table("hero_pairs", "python -m pipeline.hero_pairs"), s)
    meta_f = DATA_DIR / "hero_pairs.json"
    meta = json.loads(meta_f.read_text(encoding="utf-8")) if meta_f.exists() else {}
    df = df.round({"win_rate": 4, "expected": 4, "effect": 2, "ci_low": 2, "ci_high": 2})
    heroes = {}
    for h, g in df.groupby("hero"):
        heroes[str(int(h))] = {k: g[g["kind"] == k].sort_values("shrunk", ascending=False)[PAIR_COLS].values.tolist()
                               for k in ("with", "against")}
    return {**meta, "slice": s, "cols": PAIR_COLS, "heroes": heroes}


ITEM_COLS = ["item_id", "n", "win_rate", "expected", "effect", "ci_low", "ci_high", "lead", "median_bucket"]
TIMING_COLS = ["bucket", "n", "win_rate", "expected", "effect", "ci_low", "ci_high"]


@router.get("/items")
def items(s: SliceDep):
    """Shop items in the selected slice: win rate of the buyers, the win rate expected
    from the same hero in the same game state (soul lead and minute at purchase), and
    the effect beyond that in percentage points, with a 95% CI. `timing` splits each
    item by purchase minute (bucket labels in `buckets`). Rows are arrays in `cols` order."""
    df = _pick(_table("items", "python -m pipeline.items"), s)
    meta_f = DATA_DIR / "items.json"
    meta = json.loads(meta_f.read_text(encoding="utf-8")) if meta_f.exists() else {}
    df = df.round({"win_rate": 4, "expected": 4, "effect": 2, "ci_low": 2, "ci_high": 2, "lead": 2})
    overall = df[df["bucket"] == -1].sort_values("effect", ascending=False)
    timing = {str(int(i)): g.sort_values("bucket")[TIMING_COLS].values.tolist()
              for i, g in df[df["bucket"] >= 0].groupby("item_id")}
    rows = overall[ITEM_COLS].astype(object).where(overall[ITEM_COLS].notna(), None).values.tolist()
    return {**meta, "slice": s, "cols": ITEM_COLS, "timing_cols": TIMING_COLS, "rows": rows, "timing": timing}
