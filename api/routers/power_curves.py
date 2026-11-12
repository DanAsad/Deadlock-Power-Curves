"""Phase 1: hero power curves and scaling index."""
from typing import Annotated

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from api.store import store

router = APIRouter(tags=["power curves"])


class Slice(BaseModel):
    queue: str = "all"
    rank: str = "all"
    period: str = "all"


def slice_params(queue: str = "all", rank: str = "all", period: str = "all") -> Slice:
    s = store.fresh()
    opts = {k: {o["id"] for o in v} for k, v in s.meta["filters"].items()}
    for name, val in (("queue", queue), ("rank", rank), ("period", period)):
        if val not in opts[name]:
            raise HTTPException(422, f"unknown {name} '{val}'; options: {sorted(opts[name])}")
    if rank != "all" and queue != "ranked":
        raise HTTPException(422, "rank brackets exist for ranked matches only: set queue=ranked")
    return Slice(queue=queue, rank=rank, period=period)


SliceDep = Annotated[Slice, Depends(slice_params)]


def _pick(df: pd.DataFrame, s: Slice) -> pd.DataFrame:
    return df[(df["queue"] == s.queue) & (df["rank"] == s.rank) & (df["period"] == s.period)]


def _records(df: pd.DataFrame, cols) -> list[dict]:
    return df[cols].astype(object).where(df[cols].notna(), None).to_dict("records")


@router.get("/meta")
def meta():
    return store.fresh().meta


@router.get("/heroes")
def heroes(s: SliceDep):
    """Hero list with overall win rate and scaling index for the selected slice."""
    st = store.fresh()
    idx = _pick(st.index, s).set_index("hero_id")
    totals = (_pick(st.curves, s).groupby("hero_id")[["wins", "games"]].sum())
    out = []
    for h in st.heroes:
        row = {**h, "games": None, "win_rate": None, "scaling": None}
        if h["id"] in totals.index:
            t = totals.loc[h["id"]]
            row.update(games=int(t["games"]), win_rate=float(t["wins"] / t["games"]))
        if h["id"] in idx.index:
            r = idx.loc[h["id"]]
            row["scaling"] = {"pp_per_10min": r["pp_per_10min"], "ci_low": r["ci_low"], "ci_high": r["ci_high"]}
        out.append(row)
    return {"slice": s, "sample": _sample(s), "heroes": out}


@router.get("/power-curves")
def power_curves(s: SliceDep, hero_id: Annotated[list[int] | None, Query()] = None):
    """Win rate by game-length bucket per hero, with 95% Wilson CIs.
    Buckets under the min-games threshold are returned with enough=false."""
    df = _pick(store.fresh().curves, s)
    if hero_id:
        df = df[df["hero_id"].isin(hero_id)]
    cols = ["bucket_idx", "bucket", "mid_min", "wins", "games", "win_rate", "ci_low", "ci_high", "enough"]
    curves = [{"hero_id": int(h), "points": _records(g, cols)} for h, g in df.groupby("hero_id")]
    return {"slice": s, "sample": _sample(s), "curves": curves}


@router.get("/scaling-index")
def scaling_index(s: SliceDep):
    """Percentage points of win rate per extra 10 minutes, early-game first.
    pp_per_10min is adjusted for hero strength; raw_pp_per_10min is the plain slope."""
    df = _pick(store.fresh().index, s).sort_values("pp_per_10min")
    cols = ["hero_id", "pp_per_10min", "ci_low", "ci_high", "raw_pp_per_10min", "raw_ci_low", "raw_ci_high", "games", "win_rate", "wr_ci_low", "wr_ci_high"]
    return {"slice": s, "sample": _sample(s), "heroes": _records(df, cols)}


def _sample(s: Slice) -> dict | None:
    return store.fresh().meta["sample_sizes"].get(f"{s.queue}|{s.rank}|{s.period}")
