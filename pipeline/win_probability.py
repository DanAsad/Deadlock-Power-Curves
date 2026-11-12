"""Win-probability graph for single matches.

  python -m pipeline.win_probability                 # example matches from the model's held-out day
  python -m pipeline.win_probability --match 123 456 # specific matches (looked up in the lake)

For each match: the same per-minute rows the model was trained on (built by
the same SQL, so there is no second implementation to drift), the full model's
and the live model's win chance at every minute, and the events to annotate
the graph with (objectives, Mid-Boss, kills per minute).

The example matches are picked from the day the saved model was tested on, so
it has never seen them. Writes data/win_probability.json.
"""
import argparse
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from pipeline.config import DATA_DIR
from pipeline.win_factors import CACHE, LIST_COLS, _compact, _query, _read_rows, prepare

MODEL_DIR = DATA_DIR / "model"
OUT = DATA_DIR / "win_probability.json"
MAX_MINUTE = 45                       # the model's time grid ends here

OBJECTIVE_LABEL = [("Tier1", "guardian", "Guardian"), ("Tier2", "walker", "Walker"),
                   ("BarrackBoss", "base_guardian", "Base Guardian"),
                   ("TitanShieldGenerator", "shrine", "Shrine"), ("Titan", "patron", "Patron weakened"),
                   ("Core", "patron", "Patron destroyed")]


def load_models():
    import joblib
    info = json.loads((MODEL_DIR / "win_model.json").read_text(encoding="utf-8"))
    return joblib.load(MODEL_DIR / "win_model.joblib"), joblib.load(MODEL_DIR / "win_model_live.joblib"), info


def fetch_matches(match_ids: list[int]) -> dict[str, pd.DataFrame] | None:
    """Per-minute rows plus raw events for these matches, straight from the lake."""
    from pipeline.extract import MIN_DURATION_S, _rank_sql
    from pipeline.win_factors_sql import DAY_SQL, OBJECTIVE_KIND, RAW_MATCHES, RAW_SQL, SGN, SNAPSHOT_S
    raw = RAW_SQL.format(where=RAW_MATCHES.format(ids=",".join(str(int(i)) for i in match_ids)),
                         min_duration=MIN_DURATION_S)
    day = DAY_SQL.format(snapshots=",".join(map(str, SNAPSHOT_S)), mod=1, rem=0,      # every minute, every match
                         kind=OBJECTIVE_KIND, rank=_rank_sql(), sgn=SGN)
    one = "(SELECT * FROM wf_raw QUALIFY row_number() OVER (PARTITION BY match_id ORDER BY player_slot) = 1)"
    players = "(SELECT * FROM wf_raw QUALIFY row_number() OVER (PARTITION BY match_id, hero_id ORDER BY player_slot) = 1)"

    def run(c):
        c.execute(f"CREATE OR REPLACE TEMP TABLE wf_raw AS {raw}")
        c.execute(f"CREATE OR REPLACE TEMP TABLE wf AS {day}")
        out = {
            "rows": c.execute(f"SELECT * EXCLUDE ({', '.join(LIST_COLS)}) FROM wf").df(),
            "lists": c.execute(f"SELECT match_id, {', '.join(LIST_COLS)} FROM wf WHERE minute = 3").df(),
            "info": c.execute(f"""SELECT match_id, start_time, duration_s, queue, average_badge,
                                         (SELECT any_value(team) FROM wf_raw w WHERE w.match_id = o.match_id AND w.won) AS winner
                                  FROM {one} o""").df(),
            "players": c.execute(f"""SELECT match_id, team, hero_id::INT AS hero_id, kills[-1]::INT AS kills,
                                            len(death_t)::INT AS deaths, nw[-1]::INT AS net_worth
                                     FROM {players}""").df(),
            "objectives": c.execute(f"""SELECT match_id, unnest(obj)::VARCHAR AS name, unnest(objteam)::VARCHAR AS owner,
                                               unnest(odt)::INT AS t FROM {one}""").df(),
            "mid_boss": c.execute(f"""SELECT match_id, unnest(mbc)::VARCHAR AS team, unnest(mbt)::INT AS t FROM {one}""").df(),
            "deaths": c.execute(f"""SELECT match_id, team, unnest(death_t)::INT AS t FROM {players}""").df(),
        }
        c.execute("DROP TABLE wf; DROP TABLE wf_raw")
        return out
    return _query([None], run, f"{len(match_ids)} match(es)", timeout=600)


def _team(t: str) -> int:
    return 0 if t == "Team0" else 1


def _events(objectives: pd.DataFrame, boss: pd.DataFrame) -> list[dict]:
    ev = []
    for r in objectives.itertuples():
        if not r.t or r.t <= 0:
            continue
        kind, label = next(((k, l) for pre, k, l in OBJECTIVE_LABEL if r.name.startswith(pre)), ("objective", r.name))
        ev.append({"t": int(r.t), "kind": kind, "label": label, "by": 1 - _team(r.owner)})   # destroyed by the other team
    for r in boss.itertuples():
        if r.t and r.t > 0 and r.team in ("Team0", "Team1"):
            ev.append({"t": int(r.t), "kind": "mid_boss", "label": "Mid-Boss claimed", "by": _team(r.team)})
    return sorted(ev, key=lambda e: e["t"])


def build(match_ids: list[int], notes: dict[int, tuple[str, str]] | None = None, models=None) -> list[dict]:
    """Graph data for each match that exists in the lake as a complete, scored 6v6 game."""
    data = fetch_matches(match_ids)
    if data is None or data["rows"].empty:
        return []
    full, live, _ = models or load_models()
    info = data["info"].set_index("match_id")
    rows = _compact(data["rows"])
    day = pd.to_datetime(info["start_time"], utc=True).dt.tz_localize(None).dt.normalize()
    rows["day"] = rows["match_id"].map(day)
    df, _ = prepare(rows, data["lists"])
    df = df.sort_values(["match_id", "minute"]).reset_index(drop=True)
    df["p"], df["p_live"] = full.predict(df), live.predict(df)

    out = []
    for mid, g in df.groupby("match_id"):
        i = info.loc[mid]
        deaths = data["deaths"][data["deaths"]["match_id"] == mid]
        minute_of = np.ceil(deaths["t"].to_numpy() / 60).astype(int)            # a kill at 5:20 shows at minute 6
        died = deaths["team"].map(_team).to_numpy()
        points = []
        for r in g.itertuples():
            k = minute_of == r.minute
            points.append({"minute": int(r.minute), "p": round(float(r.p), 4), "p_live": round(float(r.p_live), 4),
                           "souls": int(round(r.souls)),
                           "kills0": int((k & (died == 1)).sum()), "kills1": int((k & (died == 0)).sum())})
        pl = data["players"][data["players"]["match_id"] == mid].sort_values("net_worth", ascending=False)
        label, blurb = (notes or {}).get(int(mid), ("", ""))
        out.append({
            "match_id": int(mid), "label": label, "blurb": blurb,
            "start_time": pd.Timestamp(i["start_time"]).tz_convert("UTC").isoformat(),
            "duration_s": int(i["duration_s"]), "queue": str(i["queue"]),
            "average_badge": None if pd.isna(i["average_badge"]) else int(i["average_badge"]),
            "winner": _team(i["winner"]),
            "truncated": bool(i["duration_s"] > MAX_MINUTE * 60 + 59),          # longer than the model's grid
            "players": [{"team": _team(p.team), "hero_id": int(p.hero_id), "kills": int(p.kills or 0),
                         "deaths": int(p.deaths), "net_worth": int(p.net_worth or 0)} for p in pl.itertuples()],
            "points": points,
            "events": _events(data["objectives"][data["objectives"]["match_id"] == mid],
                              data["mid_boss"][data["mid_boss"]["match_id"] == mid]),
        })
    order = {int(m): k for k, m in enumerate(match_ids)}
    return sorted(out, key=lambda m: order.get(m["match_id"], 0))


def pick_examples(test_day: str, models) -> dict[int, tuple[str, str]]:
    """Varied matches from the held-out day's cache (matches with a row per minute)."""
    full = models[0]
    path = CACHE / f"wf_{test_day}.parquet"
    rows = _read_rows(path, every_minute=True)
    per = rows.groupby("match_id")["minute"].nunique()
    rows = rows[rows["match_id"].isin(per.index[per > 11])].assign(day=pd.Timestamp(test_day))   # every-minute sample
    lists = pd.read_parquet(CACHE / f"wfm_{test_day}.parquet")
    df, _ = prepare(rows, lists[lists["match_id"].isin(rows["match_id"])])
    df = df.sort_values(["match_id", "minute"])
    p = full.predict(df)
    df["pw"] = np.where(df["team0_won"], p, 1 - p)                     # the eventual winner's chance
    df["side"] = np.sign(p - 0.5)
    g = df.groupby("match_id")
    s = pd.DataFrame({
        "last": g["minute"].max(), "mean": g["pw"].mean(),
        "low": df[df["minute"] >= 12].groupby("match_id")["pw"].min(),
        "flips": g["side"].apply(lambda x: int((x.diff().abs() > 1).sum())),
        "close": (df["pw"] - 0.5).abs().groupby(df["match_id"]).mean(),
        "rank": g["rank"].first(),
    }).dropna()
    s = s[(s["last"] >= 14) & (s["last"] < MAX_MINUTE)]                # whole game fits on the model's grid
    picks, used = {}, set()

    def take(label, blurb, frame, col, ascending):
        cand = frame[~frame.index.isin(used)].sort_values(col, ascending=ascending)
        if len(cand):
            mid = int(cand.index[0])
            used.add(mid)
            picks[mid] = (label, blurb)

    take("Comeback", "The winner's chance fell lower here than in any other match of the day.", s, "low", True)
    take("Back and forth", "The favourite changed more often than in any other match.", s[s["last"] >= 25], "flips", False)
    take("Stomp", "One team was ahead from the start and ended it early.", s[s["last"] <= 22], "mean", False)
    take("Coin flip to the end", "Neither team got clear of 50% for most of a long game.", s[s["last"] >= 35], "close", True)
    take("High-rank ranked match", "Oracle to Eternus lobby with several lead changes.", s[s["rank"] == "high"], "flips", False)
    typical = s[(s["last"] >= 28) & (s["last"] <= 34)]
    if len(typical):
        take("Typical game", "About average length and an average-sized lead for the winner.",
             typical.assign(d=(typical["mean"] - s["mean"].median()).abs()), "d", True)
    return picks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", type=int, nargs="*", help="match ids; default: examples from the held-out day")
    args = ap.parse_args()
    models = load_models()
    info = models[2]
    notes = {int(m): ("", "") for m in args.match} if args.match else pick_examples(info["trained_through"], models)
    print(f"Building {len(notes)} match(es): {list(notes)}", flush=True)
    matches = build(list(notes), notes, models)
    out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "model": {"held_out_day": info.get("trained_through"), "saved_at": info.get("saved_at")},
           "max_minute": MAX_MINUTE, "matches": matches}
    OUT.write_text(json.dumps(out), encoding="utf-8")
    for m in matches:
        print(f"  {m['match_id']} {m['label'] or '-':24} {m['duration_s'] // 60:>2} min, winner team {m['winner']}, "
              f"{len(m['points'])} points, {len(m['events'])} events")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
