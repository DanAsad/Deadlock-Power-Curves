"""Model check: how good is the team prediction, measured honestly.

Run from the repo root:
  python -m pipeline.evaluate --days 10        # real data (cached per day, see win_factors)
  python -m pipeline.evaluate --demo           # synthetic, offline

Two ways to split train/test, both by match (a match is never in both):
  * time:   train on every day but the newest, test on the newest day. This is
            what a live system faces: new matches, possibly a new patch.
  * random: 20% of matches held out (match_id % 5 == 0), all days mixed.

Per split and snapshot minute, on the test matches:
  * models: coin flip, souls lead only, per-minute logistic on the earlier
    factor set ("base") and on all factors ("full"), the one-model-for-the-
    whole-game ("unified") and its live-API version ("live")
  * drop-one-group tests: the full model refit without each factor group;
    the loss in log loss says how much that group really adds (95% CI)
  * log loss, Brier score, accuracy, AUC, calibration curve and its error (ECE)
Per split, over all snapshot minutes:
  * segments: the unified model by queue (ranked, unranked, low-priority,
    new-player, wide-skill party)
  * queue models: would a separate model per queue beat the shared one?
Time split only:
  * every minute: the unified model at each game minute 1-45, and whether
    training on every minute beats training on snapshot minutes only

Writes data/model_eval.json and data/model/win_model*.joblib.
"""
import argparse
import json
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from pipeline.config import DATA_DIR
from pipeline.stats import Z95
from pipeline.win_factors import (FACTORS, FLAGS, RANKED_ONLY, SNAP_MIN, TEST_SHARE, _auc, _sig, calibration,
                                  fetch_days, logit_fit, make_demo, prepare)

FEATS = [f[0] for f in FACTORS if f[0] not in RANKED_ONLY]     # all queues: no rank
# factors the model had before step 3 (player history, hero pairs, lane state, respawn timers)
NEW_FEATS = ["enemy_respawn", "open_lanes", "deepest_push", "player_form", "player_farm", "hero_mastery",
             "draft_synergy", "draft_counter"]
BASE_FEATS = [f for f in FEATS if f not in NEW_FEATS]
GROUPS = {}
for fid, _, _, _, grp in FACTORS:
    if fid in FEATS:
        GROUPS.setdefault(grp, []).append(fid)
GROUP_LABELS = {"economy": "Economy", "fights": "Fights", "objectives": "Objectives", "pre-game": "Pre-game"}
EPS = 1e-12
SAVE_MODELS = True          # False on --demo when real results exist, so a test run never replaces them
BANDS = [(1, 15), (16, 30), (31, 45)]


def fit_predict(train: pd.DataFrame, test: pd.DataFrame, feats: list[str]) -> np.ndarray:
    """Logistic regression on standardised features (train SDs); returns test P(team0 wins)."""
    feats = [c for c in feats if train[c].std() > 1e-9 and (train[c] != 0).mean() > 0.001]
    sd = {c: train[c].std() for c in feats}
    X = lambda d: np.column_stack([np.ones(len(d))] + [d[c].to_numpy(float) / sd[c] for c in feats])
    beta, _ = logit_fit(X(train), train["team0_won"].to_numpy(float))
    return _sig(X(test) @ beta)


def row_loss(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    return -(y * np.log(p + EPS) + (1 - y) * np.log(1 - p + EPS))


def scores(y: np.ndarray, p: np.ndarray) -> dict:
    out = {"log_loss": float(row_loss(y, p).mean()), "brier": float(np.mean((p - y) ** 2)),
           "accuracy": float(((p > 0.5) == y).mean())}
    out["auc"] = _auc(y, p) if np.ptp(p) > 0 else 0.5
    return out


def ece(cal: list[dict]) -> float:
    n = sum(b["n"] for b in cal)
    return float(sum(b["n"] * abs(b["observed"] - b["mean_pred"]) for b in cal) / n) if n else 0.0


def paired(d: np.ndarray, match_ids: np.ndarray | None = None) -> dict:
    """Mean of a per-row loss difference with a 95% CI. Rows of one match are
    not independent, so with match_ids the CI is over per-match means."""
    if match_ids is not None:
        d = pd.Series(d).groupby(np.asarray(match_ids)).mean().to_numpy()
    m = float(d.mean())
    half = float(Z95 * d.std(ddof=1) / np.sqrt(len(d))) if len(d) > 1 else 0.0
    return {"delta_log_loss": m, "ci_low": m - half, "ci_high": m + half}


def evaluate_minute(train: pd.DataFrame, test: pd.DataFrame, extra: dict | None = None) -> dict:
    """extra: predictions from models fit across all minutes, e.g. {"unified": p}."""
    y = test["team0_won"].to_numpy(float)
    preds = {
        "coin": np.full(len(test), 0.5),
        "souls_only": fit_predict(train, test, ["souls"]),
        "base": fit_predict(train, test, BASE_FEATS),
        "full": fit_predict(train, test, FEATS),
        **(extra or {}),
    }
    for g, cols in GROUPS.items():
        preds[f"no_{g}"] = fit_predict(train, test, [c for c in FEATS if c not in cols])

    models = {k: scores(y, p) for k, p in preds.items()}
    full_loss = row_loss(y, preds["full"])
    gain = models["coin"]["log_loss"] - models["full"]["log_loss"]     # what the model adds over a coin flip
    ablation = []
    for g in GROUPS:
        r = paired(row_loss(y, preds[f"no_{g}"]) - full_loss)        # >0: the group helps
        ablation.append({"group": g, "label": GROUP_LABELS.get(g, g), "factors": GROUPS[g], **r,
                         "share_of_gain": r["delta_log_loss"] / gain if gain > 0 else None,
                         "share_ci_low": r["ci_low"] / gain if gain > 0 else None,
                         "share_ci_high": r["ci_high"] / gain if gain > 0 else None})
    cal = calibration(preds["full"], y)
    out = {"n_train": int(len(train)), "n_test": int(len(test)), "models": models, "ablation": ablation,
           # souls-only vs full, same paired test: what all the other factors add
           "beyond_souls": paired(row_loss(y, preds["souls_only"]) - full_loss),
           # earlier factor set vs all factors: what the step 3 factors add
           "new_info": paired(row_loss(y, preds["base"]) - full_loss),
           "calibration": cal, "ece": ece(cal)}
    if "unified" in preds:
        cu = calibration(preds["unified"], y)
        out.update(calibration_unified=cu, ece_unified=ece(cu),
                   unified_vs_full=paired(full_loss - row_loss(y, preds["unified"])))   # >0: unified better
    return out


def splits(df: pd.DataFrame) -> dict[str, tuple[pd.Series, pd.Series, dict]]:
    out = {}
    if "day" in df and df["day"].nunique() >= 2:
        last = df["day"].max()
        out["time"] = (df["day"] < last, df["day"] == last,
                       {"label": "Newest day held out", "train_days": int(df["day"].nunique() - 1),
                        "test_day": str(last.date())})
    test = (df["match_id"] % TEST_SHARE) == 0
    out["random"] = (~test, test, {"label": "Random 20% of matches", "train_days": int(df["day"].nunique()) if "day" in df else None,
                                   "test_day": None})
    return out


def fit_model(df: pd.DataFrame, fit: pd.Series, calib: pd.Series, label: str, diffs=None):
    """One boosted model over all minutes; `calib` matches are used for recalibration only."""
    from pipeline.model import WinModel
    t0 = time.time()
    model = WinModel(diffs=diffs).fit(df[fit], df[calib])
    i = model.info()
    print(f"  {label}: {i['iterations']} trees on {i['train_matches']:,} matches, {i['train_rows']:,} rows "
          f"({time.time() - t0:.0f}s)", flush=True)
    return model


def segments(test: pd.DataFrame, p: np.ndarray) -> list[dict]:
    """The unified model by kind of match, over all snapshot minutes."""
    y = test["team0_won"].to_numpy(float)
    q = test["queue"].str.lower() if "queue" in test else pd.Series("", index=test.index)
    flag = lambda c: (test[c] == 1) if c in test else pd.Series(False, index=test.index)
    masks = [("all", "All matches", pd.Series(True, index=test.index)),
             ("ranked", "Ranked", q == "ranked"), ("unranked", "Unranked", q == "unranked"),
             ("standard", "Unranked, standard queue", (q == "unranked") & ~flag("low_pri") & ~flag("new_player") & ~flag("wide_party")),
             ("wide_party", "Wide-skill party", flag("wide_party")),
             ("new_player", "New-player queue", flag("new_player")),
             ("low_pri", "Low-priority queue", flag("low_pri"))]
    out = []
    for sid, label, m in masks:
        m = m.to_numpy()
        n = int(test.loc[m, "match_id"].nunique())
        if n < 300:
            continue
        out.append({"id": sid, "label": label, "matches": n, **scores(y[m], p[m]), "ece": ece(calibration(p[m], y[m]))})
    return out


def queue_models(df: pd.DataFrame, tr: pd.Series, te: pd.Series) -> list[dict]:
    """Would a separate per-minute model per queue beat the one shared model?
    Tested on each queue's own test matches, all snapshot minutes together."""
    out = []
    q = df["queue"].str.lower()
    for name, label in (("ranked", "Ranked"), ("unranked", "Unranked")):
        loss = {"shared": [], "own": [], "own_rank": []}
        ids = []
        for mnt in SNAP_MIN:
            at = df["minute"] == mnt
            test, train_all, train_q = df[at & te & (q == name)], df[at & tr], df[at & tr & (q == name)]
            if test["match_id"].nunique() < 500 or train_q["match_id"].nunique() < 2000:
                continue
            y = test["team0_won"].to_numpy(float)
            loss["shared"].append(row_loss(y, fit_predict(train_all, test, FEATS)))
            loss["own"].append(row_loss(y, fit_predict(train_q, test, FEATS)))
            if name == "ranked" and "rank_gap" in df:
                loss["own_rank"].append(row_loss(y, fit_predict(train_q, test, FEATS + ["rank_gap"])))
            ids.append(test["match_id"].to_numpy())
        if not ids:
            continue
        ids = np.concatenate(ids)
        L = {k: np.concatenate(v) for k, v in loss.items() if v}
        row = {"queue": name, "label": label, "matches": int(len(np.unique(ids))),
               "shared_log_loss": float(L["shared"].mean()), "own_log_loss": float(L["own"].mean()),
               "own_vs_shared": paired(L["shared"] - L["own"], ids)}          # >0: separate model better
        if "own_rank" in L:
            row.update(own_rank_log_loss=float(L["own_rank"].mean()),
                       rank_vs_own=paired(L["own"] - L["own_rank"], ids))      # >0: rank gap helps
        out.append(row)
    return out


def every_minute(df: pd.DataFrame, fit: pd.Series, calib: pd.Series, te: pd.Series, p_uni: pd.Series) -> dict | None:
    """Time split: the unified model at every game minute, on test matches that
    have a row per minute. Also: does training on every minute beat training on
    snapshot minutes only, at the minutes between snapshots?"""
    snap = df["minute"].isin(SNAP_MIN)
    per_match = df[te].groupby("match_id")["minute"].nunique()
    full_ids = per_match.index[per_match > df.loc[te & snap].groupby("match_id")["minute"].nunique().reindex(per_match.index, fill_value=0)]
    sel = te & df["match_id"].isin(full_ids)
    if sel.sum() == 0 or (sel & ~snap).sum() < 5000:
        return None
    t = df[sel]
    y, p, mnt = t["team0_won"].to_numpy(float), p_uni.loc[t.index].to_numpy(), t["minute"].to_numpy()
    minutes = []
    for m in sorted(np.unique(mnt)):
        k = mnt == m
        if k.sum() < 1000:
            continue
        minutes.append({"minute": int(m), "n": int(k.sum()), "snapshot": bool(m in SNAP_MIN), **scores(y[k], p[k]),
                        "ece": ece(calibration(p[k], y[k]))})
    # the same model trained on snapshot minutes only, compared between snapshots
    model_snap = fit_model(df, fit & snap, calib & snap, "snapshot-minutes-only model")
    off = t[~t["minute"].isin(SNAP_MIN)]
    yo, ids, mo = off["team0_won"].to_numpy(float), off["match_id"].to_numpy(), off["minute"].to_numpy()
    p1, p2 = p_uni.loc[off.index].to_numpy(), model_snap.predict(off)
    bands = []
    for lo, hi in [*BANDS, (1, 45)]:
        k = (mo >= lo) & (mo <= hi)
        if k.sum() < 1000:
            continue
        bands.append({"from": lo, "to": hi, "rows": int(k.sum()),
                      "every_minute_log_loss": float(row_loss(yo[k], p1[k]).mean()),
                      "snapshot_only_log_loss": float(row_loss(yo[k], p2[k]).mean()),
                      "every_minute_ece": ece(calibration(p1[k], yo[k])),
                      "snapshot_only_ece": ece(calibration(p2[k], yo[k])),
                      # >0: training on every minute is better
                      **paired(row_loss(yo[k], p2[k]) - row_loss(yo[k], p1[k]), ids[k])})
    return {"matches": int(len(full_ids)), "minutes": minutes, "between_snapshots": bands}


def ranked_model(df: pd.DataFrame, fit: pd.Series, calib: pd.Series, te: pd.Series, p_uni: pd.Series) -> dict | None:
    """Would a boosted model trained on ranked matches only beat the shared one on ranked
    matches? Saved as win_model_ranked only when the paired 95% CI excludes zero."""
    ranked = df["queue"].str.lower() == "ranked"
    if df.loc[fit & ranked, "match_id"].nunique() < 20_000 or df.loc[te & ranked, "match_id"].nunique() < 1000:
        return None
    model = fit_model(df, fit & ranked, calib & ranked, "ranked-only model")
    t = df[te & ranked & df["minute"].isin(SNAP_MIN)]
    y, ids = t["team0_won"].to_numpy(float), t["match_id"].to_numpy()
    p_own, p_shared = model.predict(t), p_uni.loc[t.index].to_numpy()
    cmp = paired(row_loss(y, p_shared) - row_loss(y, p_own), ids)          # >0: ranked-only better
    out = {"matches": int(len(np.unique(ids))), "train_matches": model.info()["train_matches"],
           "shared": {**scores(y, p_shared), "ece": ece(calibration(p_shared, y))},
           "own": {**scores(y, p_own), "ece": ece(calibration(p_own, y))},
           "own_vs_shared": cmp, "used": bool(cmp["ci_low"] > 0)}
    print(f"  ranked-only model: log loss {out['own']['log_loss']:.4f} vs shared {out['shared']['log_loss']:.4f} "
          f"(gain {cmp['delta_log_loss']:+.4f}, CI {cmp['ci_low']:+.4f} to {cmp['ci_high']:+.4f}) -> "
          f"{'saved' if out['used'] else 'not used'}", flush=True)
    return out, model


def run(df: pd.DataFrame) -> dict:
    from pipeline.model import LIVE_DIFFS, STREAM_DIFFS
    result = {}
    snap = df["minute"].isin(SNAP_MIN)
    for name, (tr, te, info) in splits(df).items():
        calib = tr & (df["match_id"] % 10 == 7)          # 10% of training matches: recalibration only
        fit = tr & ~calib
        model = fit_model(df, fit, calib, f"{name}: unified model")
        live = fit_model(df, fit, calib, f"{name}: live model", LIVE_DIFFS)
        p_uni = pd.Series(model.predict(df[te]), index=df.index[te])
        p_raw = pd.Series(model.predict_raw(df[te]), index=df.index[te])
        p_live = pd.Series(live.predict(df[te]), index=df.index[te])
        extra_p = {}
        if name == "time":
            save_model(model, info, "win_model")
            save_model(live, info, "win_model_live")
            stream = fit_model(df, fit, calib, f"{name}: stream model", STREAM_DIFFS)
            save_model(stream, info, "win_model_stream")
            extra_p["stream"] = pd.Series(stream.predict(df[te]), index=df.index[te])
        minutes = []
        for mnt in SNAP_MIN:
            at = df["minute"] == mnt
            train, test = df[at & tr], df[at & te]
            if test["match_id"].nunique() < 1000 or train["match_id"].nunique() < 2000:
                continue
            r = evaluate_minute(train, test, {"unified": p_uni.loc[test.index].to_numpy(),
                                              "unified_raw": p_raw.loc[test.index].to_numpy(),
                                              "live": p_live.loc[test.index].to_numpy(),
                                              **{k: v.loc[test.index].to_numpy() for k, v in extra_p.items()}})
            minutes.append({"minute": int(mnt), **r})
            m = r["models"]
            print(f"  {name:6} min {mnt:>2}: log loss unified {m['unified']['log_loss']:.4f} | per-minute "
                  f"{m['full']['log_loss']:.4f} | before step 3 {m['base']['log_loss']:.4f} | live "
                  f"{m['live']['log_loss']:.4f} | souls only {m['souls_only']['log_loss']:.4f} | acc "
                  f"{m['unified']['accuracy']:.3f} | ECE {r['ece_unified']:.4f}", flush=True)
        ts = df[te & snap]
        y = ts["team0_won"].to_numpy(float)
        result[name] = {
            **info,
            "unified": {**model.info(), "overall": scores(y, p_uni.loc[ts.index].to_numpy())},
            "live": {**live.info(), "overall": scores(y, p_live.loc[ts.index].to_numpy())},
            "matches_train": int(df.loc[tr, "match_id"].nunique()),
            "matches_test": int(df.loc[te, "match_id"].nunique()), "minutes": minutes,
            "segments": segments(ts, p_uni.loc[ts.index].to_numpy()),
            "queue_models": queue_models(df, tr, te) if "queue" in df else [],
        }
        if name == "time":
            result[name]["stream"] = {**stream.info(), "overall": scores(y, extra_p["stream"].loc[ts.index].to_numpy())}
            rm = ranked_model(df, fit, calib, te, p_uni) if "queue" in df else None
            if SAVE_MODELS:
                (DATA_DIR / "model" / "win_model_ranked.joblib").unlink(missing_ok=True)
            if rm:
                result[name]["ranked_model"] = rm[0]
                if rm[0]["used"]:
                    save_model(rm[1], info, "win_model_ranked")
            result[name]["every_minute"] = every_minute(df, fit, calib, te, p_uni)
        for s in result[name]["segments"]:
            print(f"  {name:6} {s['label']:26} {s['matches']:>8,} matches | log loss {s['log_loss']:.4f} | "
                  f"acc {s['accuracy']:.3f} | ECE {s['ece']:.4f}", flush=True)
    return result


SEGMENT_MODELS = [            # (id, label, queue, rank bracket or None)
    ("ranked", "Ranked", "ranked", None), ("unranked", "Unranked", "unranked", None),
    ("ranked_low", "Ranked, Initiate–Arcanist", "ranked", "low"),
    ("ranked_mid", "Ranked, Ritualist–Archon", "ranked", "mid"),
    ("ranked_high", "Ranked, Oracle–Eternus", "ranked", "high"),
]


def segment_models(df: pd.DataFrame) -> None:
    """A separate full model per queue and per rank bracket, each tested against the saved
    shared model on its own held-out matches (time split, snapshot minutes, paired by match).
    A segment's model is saved as win_model_<id> only when its 95% CI excludes zero."""
    import joblib
    tr, te, info = splits(df)["time"]
    calib = tr & (df["match_id"] % 10 == 7)
    fit = tr & ~calib
    shared = joblib.load(DATA_DIR / "model" / "win_model.joblib")
    q = df["queue"].str.lower()
    out = []
    for sid, label, queue, rank in SEGMENT_MODELS:
        seg = (q == queue) & ((df["rank"] == rank) if rank else True)
        n_fit, n_test = df.loc[fit & seg, "match_id"].nunique(), df.loc[te & seg, "match_id"].nunique()
        (DATA_DIR / "model" / f"win_model_{sid}.joblib").unlink(missing_ok=True)
        (DATA_DIR / "model" / f"win_model_{sid}.json").unlink(missing_ok=True)
        if n_fit < 20_000 or n_test < 1000:
            out.append({"id": sid, "label": label, "train_matches": int(n_fit), "matches": int(n_test), "skipped": True})
            print(f"  {label}: too few matches ({n_fit:,} to train, {n_test:,} to test)", flush=True)
            continue
        model = fit_model(df, fit & seg, calib & seg, f"{label} model")
        t = df[te & seg & df["minute"].isin(SNAP_MIN)]
        y, ids = t["team0_won"].to_numpy(float), t["match_id"].to_numpy()
        p_own, p_shared = model.predict(t), shared.predict(t)
        cmp = paired(row_loss(y, p_shared) - row_loss(y, p_own), ids)          # >0: the segment's own model is better
        used = bool(cmp["ci_low"] > 0)
        out.append({"id": sid, "label": label, "train_matches": int(n_fit), "matches": int(len(np.unique(ids))),
                    "shared": {**scores(y, p_shared), "ece": ece(calibration(p_shared, y))},
                    "own": {**scores(y, p_own), "ece": ece(calibration(p_own, y))},
                    "own_vs_shared": cmp, "used": used})
        if used:
            save_model(model, info, f"win_model_{sid}")
        print(f"  {label}: own {out[-1]['own']['log_loss']:.4f} (acc {out[-1]['own']['accuracy']:.4f}) vs shared "
              f"{out[-1]['shared']['log_loss']:.4f} (acc {out[-1]['shared']['accuracy']:.4f}); gain "
              f"{cmp['delta_log_loss']:+.4f}, CI {cmp['ci_low']:+.4f} to {cmp['ci_high']:+.4f} -> "
              f"{'saved' if used else 'not used'}", flush=True)
        del model
    target = DATA_DIR / "model_eval.json"
    res = json.loads(target.read_text(encoding="utf-8"))
    res["splits"]["time"]["segment_models"] = out
    target.write_text(json.dumps(res), encoding="utf-8")


def refit_stream(df: pd.DataFrame) -> None:
    """Fit and save only the stream model (time split) and update its scores in model_eval.json."""
    from pipeline.model import STREAM_DIFFS
    tr, te, info = splits(df)["time"]
    calib = tr & (df["match_id"] % 10 == 7)
    stream = fit_model(df, tr & ~calib, calib, "time: stream model", STREAM_DIFFS)
    save_model(stream, info, "win_model_stream")
    t = df[te & df["minute"].isin(SNAP_MIN)]
    y, p, mnt = t["team0_won"].to_numpy(float), stream.predict(t), t["minute"].to_numpy()
    target = DATA_DIR / "model_eval.json"
    out = json.loads(target.read_text(encoding="utf-8"))
    s = out["splits"]["time"]
    s["stream"] = {**stream.info(), "overall": scores(y, p)}
    for m in s["minutes"]:
        k = mnt == m["minute"]
        m["models"]["stream"] = scores(y[k], p[k])
        print(f"  min {m['minute']:>2}: stream log loss {m['models']['stream']['log_loss']:.4f} | full {m['models']['unified']['log_loss']:.4f}")
    print(f"  overall: log loss {s['stream']['overall']['log_loss']:.4f}, accuracy {s['stream']['overall']['accuracy']:.4f}")
    target.write_text(json.dumps(out), encoding="utf-8")


def save_model(model, info: dict, name: str):
    """Keep the newest-day-held-out models for the win-probability system."""
    import joblib
    if not SAVE_MODELS:
        return
    out = DATA_DIR / "model"
    out.mkdir(exist_ok=True)
    joblib.dump(model, out / f"{name}.joblib")
    (out / f"{name}.json").write_text(json.dumps({**model.info(), "trained_through": info.get("test_day"),
                                                  "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
                                                 indent=1), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--days", type=int, default=10, help="complete UTC days to use")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--stream-only", action="store_true", help="refit only the stream model; keep the other results")
    ap.add_argument("--segments-only", action="store_true", help="only test a separate model per queue and rank bracket")
    args = ap.parse_args()

    patches = []
    target = DATA_DIR / "model_eval.json"
    real = target.exists() and json.loads(target.read_text(encoding="utf-8")).get("source") != "demo"
    if args.demo and real:
        global SAVE_MODELS
        SAVE_MODELS = False
        print("Real results exist: this demo run will not replace them or the saved models.")
    if args.demo:
        df, source = make_demo(), "demo"
        df["day"] = pd.Timestamp("2026-01-01") + pd.to_timedelta(df["match_id"] % 3, "D")
    else:
        from pipeline.patches import load
        patches = load()
        print(f"Loading {args.days} complete days…", flush=True)
        rows, matches = fetch_days(args.days, args.refresh, every_minute=True)
        df, _ = prepare(rows, matches)
        del rows, matches
        source = "deadlock-api data lake"
    df = df[df["queue"].str.lower().isin(["ranked", "unranked"])].reset_index(drop=True)
    print(f"{df['match_id'].nunique():,} matches, {len(df):,} rows over {df['day'].nunique()} days; evaluating…", flush=True)
    if args.stream_only:
        return refit_stream(df)
    if args.segments_only:
        return segment_models(df)
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source, "days": int(df["day"].nunique()),
        "first_day": str(df["day"].min().date()), "last_day": str(df["day"].max().date()),
        "latest_patch": patches[-1] if patches else None,
        "groups": [{"id": g, "label": GROUP_LABELS.get(g, g), "factors": c} for g, c in GROUPS.items()],
        "new_factors": NEW_FEATS, "flags": FLAGS,
        "splits": run(df),
    }
    if not SAVE_MODELS:
        return
    target.write_text(json.dumps(out), encoding="utf-8")
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
