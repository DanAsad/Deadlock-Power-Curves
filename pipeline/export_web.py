"""Export the saved win models and draft tables as JSON the browser can run.

  python -m pipeline.export_web            # data/web/*.json (shipped with the static site)
  python -m pipeline.export_web --fixtures # also web/src/wp/fixtures/*.json for the parity test

The static site has no backend, so web/src/wp/ scores matches in the browser:
it rebuilds the per-minute rows from the Deadlock API's match metadata and runs
these exported models. What the browser version does not have:
  * player history (30-day records per account): those factors are 0 = average
  * player ranks (not in the API): rank_gap is 0
The fixtures hold trimmed API responses plus the pipeline's own predictions
with the same two limits applied, so `npm run test:parity` can check that both
implementations agree.
"""
import argparse
import json
import urllib.request
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd

from pipeline.config import DATA_DIR, ROOT
from pipeline.heroes import UA
from pipeline.model import CONTEXT, RANKED_ONLY_DIFFS, WinModel
from pipeline.win_factors import CACHE, SNAP_MIN, hero_priors, pair_priors

OUT = DATA_DIR / "web"
FIXTURES = ROOT / "web" / "src" / "wp" / "fixtures"
NO_HISTORY = ["hero_experience", "player_form", "player_farm", "hero_mastery", "rank_gap"]   # 0 in the browser
METADATA_URL = "https://api.deadlock-api.com/v1/matches/{id}/metadata"


def _r(a, digits=7) -> list:
    """Floats rounded to `digits` significant digits (keeps the JSON small)."""
    return [float(f"{float(v):.{digits}g}") for v in np.asarray(a).ravel()]


def model_json(m: WinModel) -> dict:
    trees = {"offset": [0], "feature": [], "threshold": [], "left": [], "right": [], "value": [], "missing_left": []}
    for (pred,) in m.clf._predictors:                     # binary classifier: one tree per iteration
        n = pred.nodes
        leaf = n["is_leaf"].astype(bool)
        trees["feature"] += [-1 if l else int(f) for l, f in zip(leaf, n["feature_idx"])]
        trees["threshold"] += _r(np.where(leaf, 0, n["num_threshold"]), 9)
        trees["left"] += [0 if l else int(v) for l, v in zip(leaf, n["left"])]
        trees["right"] += [0 if l else int(v) for l, v in zip(leaf, n["right"])]
        trees["value"] += _r(np.where(leaf, n["value"], 0), 6)
        trees["missing_left"] += [int(v) for v in n["missing_go_to_left"]]
        trees["offset"].append(len(trees["feature"]))
    table = lambda q: {"minutes": _r(m.tables[q][0]), "weights": [_r(row, 8) for row in m.tables[q][1]]}
    return {
        "diffs": m.diffs, "feats": m.feats, "context": CONTEXT, "ranked_only": sorted(RANKED_ONLY_DIFFS),
        "mirrored": m.mirrored, "snap_minutes": SNAP_MIN,
        "tables": {"unranked": table(False), "ranked": table(True)},
        "baseline": float(np.asarray(m.clf._baseline_prediction).ravel()[0]),
        "trees": trees,
        "iso": {"x": _r(m.iso.X_thresholds_, 8), "y": _r(m.iso.y_thresholds_, 8)},
        "clip": 1e-4,
    }


def priors_json(before: date) -> dict:
    """Hero and hero-pair tables from the days before `before`, as the pipeline would use on that day."""
    scale, wr, _ = hero_priors(before)
    S, C = pair_priors(before)
    ids = sorted(int(h) for h in wr)
    pairs = lambda M, sym: [[a, b, round(float(M[a, b]), 6)] for a in ids for b in ids
                            if (a < b if sym else a != b) and abs(M[a, b]) > 1e-9]
    return {"as_of": str(before), "heroes": {str(h): {"scaling": round(float(scale.get(h, 0.0)), 5),
                                                      "win_rate": round(float(wr.get(h, 0.5)), 6)} for h in ids},
            "synergy": pairs(S, True), "counter": [p for p in pairs(C, False) if p[0] < p[1]]}


def _latest_cached_day() -> date:
    days = sorted(f.stem[3:] for f in CACHE.glob("hp_*.parquet"))
    return date.fromisoformat(days[-1]) + timedelta(days=1) if days else datetime.now(timezone.utc).date()


def trim(mi: dict) -> dict:
    """The fields of a match-metadata response the browser code reads."""
    stat = ("time_stamp_s", "net_worth", "kills", "level", "creep_kills", "neutral_kills", "denies",
            "player_damage", "boss_damage", "gold_death_loss")
    return {
        **{k: mi.get(k) for k in ("match_id", "start_time", "duration_s", "match_outcome", "winning_team", "game_mode",
                                  "match_mode", "is_high_skill_range_parties", "low_pri_pool", "new_player_pool",
                                  "not_scored", "mid_boss")},
        "objectives": [{k: o.get(k) for k in ("team_objective_id", "team", "destroyed_time_s")} for o in mi["objectives"]],
        "players": [{**{k: p.get(k) for k in ("account_id", "player_slot", "team", "hero_id", "kills", "deaths",
                                              "net_worth", "abandon_match_time_s")},
                     "stats": [{k: s.get(k) for k in stat} for s in p["stats"]],
                     "death_details": [{k: d.get(k) for k in ("game_time_s", "death_duration_s")} for d in p["death_details"]]}
                    for p in mi["players"]],
    }


def write_fixtures(match_ids: list[int], models) -> None:
    """Trimmed API responses and the pipeline's predictions under the browser's limits."""
    from pipeline.win_factors import _compact, prepare
    from pipeline.win_probability import fetch_matches
    data = fetch_matches(match_ids)
    info = data["info"].set_index("match_id")
    rows = _compact(data["rows"])
    rows["day"] = rows["match_id"].map(pd.to_datetime(info["start_time"], utc=True).dt.tz_localize(None).dt.normalize())
    df, _ = prepare(rows, data["lists"])
    df[NO_HISTORY] = 0.0
    df = df.sort_values(["match_id", "minute"]).reset_index(drop=True)
    full, live = models
    df["p"], df["p_live"] = full.predict(df), live.predict(df)
    X = full.features(df)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    day = min(pd.Timestamp(d).date() for d in rows["day"].unique())
    (FIXTURES / "priors.json").write_text(json.dumps(priors_json(day)), encoding="utf-8")
    for mid in match_ids:
        req = urllib.request.Request(METADATA_URL.format(id=mid), headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = json.loads(r.read().decode("utf-8"))
        k = (df["match_id"] == mid).to_numpy()
        expected = [{"minute": int(r.minute), "p": float(r.p), "p_live": float(r.p_live),
                     "features": dict(zip(full.feats, _r(x, 7)))} for r, x in zip(df[k].itertuples(), X[k])]
        (FIXTURES / f"{mid}.json").write_text(json.dumps({"metadata": trim(raw.get("match_info", raw)),
                                                          "expected": expected}), encoding="utf-8")
        print(f"  fixture {mid}: {int(k.sum())} minutes")


def main():
    from pipeline.win_probability import load_models
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", action="store_true", help="also write the parity-test fixtures")
    args = ap.parse_args()
    full, live, info = load_models()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, m in (("win_model", full), ("win_model_live", live)):
        f = OUT / f"{name}.json"
        f.write_text(json.dumps(model_json(m), separators=(",", ":")), encoding="utf-8")
        print(f"wrote {f} ({f.stat().st_size / 1e6:.1f} MB, {len(m.clf._predictors)} trees)")
    pri = priors_json(_latest_cached_day())
    (OUT / "priors.json").write_text(json.dumps({**pri, "model_held_out_day": info.get("trained_through")},
                                                separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT / 'priors.json'} (as of {pri['as_of']}, {len(pri['heroes'])} heroes)")
    if args.fixtures:
        d = json.loads((DATA_DIR / "win_probability.json").read_text(encoding="utf-8"))
        write_fixtures([m["match_id"] for m in d["matches"]][:3], (full, live))


if __name__ == "__main__":
    main()
