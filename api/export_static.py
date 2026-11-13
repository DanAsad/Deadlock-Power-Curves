"""Write every API response as a JSON file, for hosting without a backend
(GitHub Pages). The frontend built with VITE_STATIC=1 reads these files.

  python -m api.export_static web/dist/data

Layout (slice = queue_rank_period, e.g. ranked_high_all):
  meta.json, model-eval.json
  heroes/<slice>.json, power-curves/<slice>.json, scaling-index/<slice>.json,
  win-factors/<slice>.json, at-minute/<slice>.json, hero-pairs/<slice>.json
  win-probability.json (example matches), win-probability/<match_id>.json
  web-model/<name>.json (models and draft tables run in the browser)
"""
import json
import shutil
import sys
from pathlib import Path

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from api.routers import hero_extra, model_eval, power_curves, win_factors, win_probability
from api.store import store


def slices() -> list[power_curves.Slice]:
    f = store.fresh().meta["filters"]
    out = []
    for q in f["queue"]:
        for r in f["rank"]:
            if r["id"] != "all" and q["id"] != "ranked":      # rank brackets exist for ranked only
                continue
            for p in f["period"]:
                out.append(power_curves.Slice(queue=q["id"], rank=r["id"], period=p["id"]))
    return out


def write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(jsonable_encoder(payload), separators=(",", ":")), encoding="utf-8")


def export(out: Path) -> int:
    n = 0
    write(out / "meta.json", power_curves.meta()); n += 1
    for name, fn in (("model-eval", model_eval.model_eval),):
        try:
            write(out / f"{name}.json", fn()); n += 1
        except HTTPException as e:                             # optional table not built yet
            print(f"skipped {name}: {e.detail}")
    try:                                                       # example matches; no on-demand lookup here
        listing = {**win_probability.matches(), "lookup": False}
        write(out / "win-probability.json", listing); n += 1
        for m in listing["matches"]:
            write(out / "win-probability" / f"{m['match_id']}.json", win_probability.match(m["match_id"])); n += 1
    except HTTPException as e:
        print(f"skipped win-probability: {e.detail}")
    for name in win_probability.WEB_FILES:                      # models the browser runs
        src = win_probability.DATA_DIR / "web" / f"{name}.json"
        if src.exists():
            (out / "web-model").mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, out / "web-model" / f"{name}.json"); n += 1
        else:
            print(f"skipped web-model/{name}: run python -m pipeline.export_web")
    per_slice = {"heroes": power_curves.heroes, "power-curves": lambda s: power_curves.power_curves(s, None),
                 "scaling-index": power_curves.scaling_index, "win-factors": win_factors.win_factors,
                 "at-minute": lambda s: hero_extra.at_minute(s, None), "hero-pairs": hero_extra.hero_pairs}
    for s in slices():
        key = f"{s.queue}_{s.rank}_{s.period}"
        for name, fn in per_slice.items():
            try:
                write(out / name / f"{key}.json", fn(s)); n += 1
            except HTTPException as e:
                print(f"skipped {name}/{key}: {e.detail}")
    return n


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "web/dist/data")
    print(f"wrote {export(target)} files to {target}")
