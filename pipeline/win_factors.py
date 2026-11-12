"""What wins games: how much each in-game factor is tied to winning, by game minute.

Run from the repo root:
  python -m pipeline.win_factors --days 2       # real data (cached per day in data/cache/wf_*)
  python -m pipeline.win_factors --demo         # synthetic, offline

For every filter slice (queue x rank) and snapshot minute it reports, per factor:
  * on its own: how often the team ahead in that factor wins (descriptive, all matches)
  * unique weight: a multivariate logistic regression on standardised team
    differences, fit on 80% of matches; the weight is shown as "a 1-SD lead in
    this factor alone moves an even game to X%", with a 95% CI
plus held-out (20% of matches, split by match) accuracy, AUC, log loss, Brier
score and a calibration curve.

Writes data/win_factors.json.
"""
import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from pipeline.build import QUEUE_RANK
from pipeline.config import DATA_DIR
from pipeline.stats import Z95, wilson

FACTORS = [
    # id, label, unit, description, group
    ("souls", "Souls (net worth)", "souls", "Team souls difference", "economy"),
    ("kills", "Kills", "kills", "Team kills difference", "fights"),
    ("levels", "Hero levels", "levels", "Sum of hero levels difference", "economy"),
    ("last_hits", "Last hits", "creeps", "Lane + neutral creep kills difference", "economy"),
    ("denies", "Denies", "denies", "Denied souls difference", "economy"),
    ("hero_damage", "Hero damage", "damage", "Damage dealt to enemy heroes difference", "fights"),
    ("guardians", "Guardians", "objectives", "Enemy Guardians destroyed minus own lost", "objectives"),
    ("walkers", "Walkers", "objectives", "Enemy Walkers destroyed minus own lost", "objectives"),
    ("base_guardians", "Base Guardians", "objectives", "Enemy Base Guardians destroyed minus own lost", "objectives"),
    ("shrines", "Shrines", "objectives", "Enemy Shrines destroyed minus own lost", "objectives"),
    ("mid_boss", "Mid-Boss", "claims", "Mid-Boss rejuvenators claimed minus enemy's", "objectives"),
    ("open_lanes", "Open lanes", "lanes", "Lanes where the enemy lost both Guardian and Walker, minus own", "objectives"),
    ("deepest_push", "Deepest push", "objectives", "Most objectives destroyed in one enemy lane, minus the enemy's deepest", "objectives"),
    ("objective_damage", "Objective damage", "damage", "Damage dealt to bosses and objectives so far (siege pressure)", "objectives"),
    ("enemies_dead", "Enemies dead now", "players", "Enemy heroes dead at this moment minus own", "fights"),
    ("enemy_dead_time", "Enemy time dead", "seconds", "Seconds enemies have spent dead so far minus own", "fights"),
    ("enemy_respawn", "Enemy respawn time left", "seconds", "Seconds until dead enemies respawn, summed, minus own", "fights"),
    ("enemy_souls_lost", "Enemy souls lost on death", "souls", "Souls enemies dropped when dying minus own", "fights"),
    ("enemy_abandons", "Enemy abandons", "players", "Enemy players who left the match minus own", "fights"),
    ("momentum", "Soul lead momentum", "souls / 5 min", "Change in the soul lead between the two latest stats snapshots, per 5 minutes", "economy"),
    ("carry_concentration", "Carry concentration", "share pts", "Richest player's share of team souls minus enemy's (style, not advantage)", "economy"),
    ("rank_gap", "Rank advantage", "sub-ranks", "Average pre-match rank minus enemy's, in sub-ranks (ranked only)", "pre-game"),
    ("draft_scaling", "Draft scaling", "pp / 10 min", "Sum of picked heroes' scaling index minus enemy's (late-game draft = +)", "pre-game"),
    ("draft_strength", "Draft strength", "pp", "Sum of picked heroes' win rate above 50% minus enemy's", "pre-game"),
    ("hero_experience", "Hero experience", "games", "Average games each player had on their hero in the 30 days before, capped at 50, minus enemy's", "pre-game"),
    ("player_form", "Player recent win rate", "pp", "Players' win rate over the 30 days before (pulled toward 50% when few games), team average minus enemy's", "pre-game"),
    ("player_farm", "Player farming history", "souls / min", "Players' average souls per minute over the 30 days before, team average minus enemy's", "pre-game"),
    ("hero_mastery", "Win rate on picked hero", "pp", "Players' 30-day win rate on the hero they picked (pulled toward 50%), team average minus enemy's", "pre-game"),
    ("draft_synergy", "Draft synergy", "pp", "How the picked heroes do together beyond their own win rates, minus enemy's", "pre-game"),
    ("draft_counter", "Draft counters", "pp", "How the picked heroes do against the enemy's heroes beyond their own win rates", "pre-game"),
]
RANKED_ONLY = {"rank_gap"}
# A plain-language step for "effect per step", e.g. one more Walker, 1,000 souls.
STEP = {"souls": (1000, "1,000 souls"), "kills": (1, "1 kill"), "levels": (1, "1 hero level"),
        "last_hits": (10, "10 last hits"), "denies": (5, "5 denies"), "hero_damage": (1000, "1,000 damage"),
        "guardians": (1, "1 Guardian"), "walkers": (1, "1 Walker"), "base_guardians": (1, "1 Base Guardian"),
        "shrines": (1, "1 Shrine"), "mid_boss": (1, "1 Mid-Boss claim"),
        "objective_damage": (1000, "1,000 objective damage"), "enemies_dead": (1, "1 enemy dead"),
        "enemy_dead_time": (60, "60 s of enemy time dead"), "enemy_souls_lost": (1000, "1,000 enemy souls lost"),
        "enemy_abandons": (1, "1 enemy leaver"), "momentum": (1000, "1,000 souls / 5 min of momentum"),
        "carry_concentration": (5, "5 share points more concentrated"), "rank_gap": (1, "1 sub-rank"),
        "draft_scaling": (1, "1 pp/10 min more late-game draft"), "draft_strength": (1, "1 pp stronger draft"),
        "hero_experience": (5, "5 more games each on their hero"),
        "enemy_respawn": (30, "30 s of enemy respawn time"), "open_lanes": (1, "1 open lane"),
        "deepest_push": (1, "1 objective deeper"), "player_form": (1, "1 pp higher recent win rate"),
        "player_farm": (50, "50 souls/min better farmers"), "hero_mastery": (1, "1 pp higher win rate on their hero"),
        "draft_synergy": (1, "1 pp of synergy"), "draft_counter": (1, "1 pp of counters")}
FEATURES = [f[0] for f in FACTORS]
DERIVED = {"draft_scaling", "draft_strength", "hero_experience", "player_form", "player_farm",
           "hero_mastery", "draft_synergy", "draft_counter"}                    # computed in Python
MIN_MATCHES = 2000          # skip a slice x minute with fewer matches
TEST_SHARE = 5              # match_id % 5 == 0 -> held out (20%)
CACHE = DATA_DIR / "cache"
FINAL_AFTER_DAYS = 2
HISTORY_DAYS = 30           # player, hero-experience and draft-prior look-back
KEEP_CACHE_DAYS = 45        # cache files older than this are deleted
EXPERIENCE_CAP = 50
SNAP_MIN = [3, 6, 9, 12, 15, 20, 25, 30, 35, 40, 45]     # minutes with exact stats snapshots
LIST_COLS = ["heroes0", "heroes1", "accounts0", "accounts1"]
FLAGS = ["low_pri", "new_player", "wide_party"]           # match-level queue flags (context, not factors)
EXTRA_COLS = {"total_souls", *FLAGS}                      # not factors, but used by the unified model
CACHE_VERSION = "wf3"       # bump when the day query changes meaning; older wf_ files are refetched
MINUTE_SAMPLE = (5, 2)      # matches with match_id % 5 == 2 can be loaded at every minute
FORM_PRIOR, FARM_PRIOR, MASTERY_PRIOR = 20, 5, 10         # pseudo-games pulling player stats to the average
PAIR_PRIOR = 2000           # pseudo-games pulling hero-pair effects to zero


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
def _query(con_holder: list, sql_fn, label: str, timeout: int = 1800):
    """Run sql_fn(con) with a timeout and up to 3 attempts; reconnects on failure."""
    from pipeline.extract import _connect, _run_with_timeout
    for attempt in range(1, 4):
        try:
            if con_holder[0] is None:
                con_holder[0] = _connect()
            return _run_with_timeout(con_holder[0], sql_fn, timeout)
        except Exception as e:
            print(f"  {label}: attempt {attempt} failed ({str(e).splitlines()[0][:120]})", flush=True)
            con_holder[0] = None
            time.sleep(5 * attempt)
    return None


def _read_rows(path, every_minute: bool) -> pd.DataFrame:
    """Rows at the snapshot minutes for every match; with every_minute, also all
    other minutes for the 1-in-5 sample of matches."""
    import duckdb
    cond = f"minute IN ({', '.join(map(str, SNAP_MIN))})"
    if every_minute:
        cond += f" OR match_id % {MINUTE_SAMPLE[0]} = {MINUTE_SAMPLE[1]}"
    return duckdb.sql(f"SELECT * FROM read_parquet('{path.as_posix()}') WHERE {cond}").df()


def _has_columns(path, cols: set) -> bool:
    import pyarrow.parquet as pq
    if not path.exists():
        return False
    sch = pq.read_schema(path)
    return cols <= set(sch.names) and (sch.metadata or {}).get(b"wf_version") == CACHE_VERSION.encode()


def _save(df: pd.DataFrame, path, meta: dict | None = None):
    """Write then rename, so another process never reads a half-written file."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    t = pa.Table.from_pandas(df, preserve_index=False)
    if meta:
        t = t.replace_schema_metadata({**(t.schema.metadata or {}), **{k.encode(): v.encode() for k, v in meta.items()}})
    pq.write_table(t, tmp)
    os.replace(tmp, path)


def fetch_days(days: int, refresh: bool = False, every_minute: bool = False, newest_first: bool = False,
               history: bool = True) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Match-minute rows (wf_<day>) and match-level drafts/accounts (wfm_<day>) for
    the last `days` complete days, plus the history days they need:
    ph_<day> (games, wins, souls/min per player and hero) and hp_<day> (hero pairs)."""
    from pipeline.extract import MIN_DURATION_S, _rank_sql
    from pipeline.win_factors_sql import (DAY_SQL, HERO_PAIR_SQL, HISTORY_RAW_SQL, OBJECTIVE_KIND,
                                          PLAYER_HERO_SQL, RAW_DAY, RAW_SQL, SGN, SNAPSHOT_S)

    CACHE.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    # complete days only: today is partial and skews toward short games
    wanted = [today - timedelta(days=i) for i in range(days, 0, -1)]
    final = lambda d: (today - d).days >= FINAL_AFTER_DAYS and not refresh
    need = (set(FEATURES) - DERIVED) | EXTRA_COLS
    con, rows, matches = [None], [], []
    for d in (wanted[::-1] if newest_first else wanted):
        rp, mp = CACHE / f"wf_{d}.parquet", CACHE / f"wfm_{d}.parquet"
        if final(d) and mp.exists() and _has_columns(rp, need):
            rows.append(_read_rows(rp, every_minute).assign(day=pd.Timestamp(d)))
            matches.append(pd.read_parquet(mp))
            continue
        when = dict(where=RAW_DAY.format(day=d, next_day=d + timedelta(days=1)), min_duration=MIN_DURATION_S)
        sql = DAY_SQL.format(snapshots=",".join(map(str, SNAPSHOT_S)), mod=MINUTE_SAMPLE[0], rem=MINUTE_SAMPLE[1],
                             kind=OBJECTIVE_KIND, rank=_rank_sql(), sgn=SGN)
        t0 = time.time()
        # 1) download the day into a local table (the part that can stall), 2) compute locally
        n_raw = _query(con, lambda c, w=when: c.execute(
            f"CREATE OR REPLACE TEMP TABLE wf_raw AS {RAW_SQL.format(**w)}").fetchone()[0], f"{d} download", timeout=900)
        if n_raw is None:
            print(f"  {d}: skipped after 3 attempts", flush=True)
            continue
        t1 = time.time()

        def run(c, sql=sql):
            c.execute(f"CREATE OR REPLACE TEMP TABLE wf AS {sql}")
            r = c.execute(f"SELECT * EXCLUDE ({', '.join(LIST_COLS)}) FROM wf").df()
            m = c.execute(f"SELECT match_id, {', '.join(LIST_COLS)} FROM wf WHERE minute = 3").df()
            c.execute("DROP TABLE wf; DROP TABLE wf_raw")
            return r, m
        try:
            from pipeline.extract import _run_with_timeout
            res = _run_with_timeout(con[0], run, 1800)
        except Exception as e:
            print(f"  {d}: compute failed ({str(e).splitlines()[0][:160]})", flush=True)
            con[0] = None
            continue
        r, m = _compact(res[0]), res[1]
        _save(r, rp, {"wf_version": CACHE_VERSION})
        _save(m, mp)
        n_rows = len(r)
        del r, res
        rows.append(_read_rows(rp, every_minute).assign(day=pd.Timestamp(d)))
        matches.append(m)
        print(f"  {d}: {len(m):,} matches, {n_rows:,} rows (download {t1 - t0:.0f}s, compute {time.time() - t1:.0f}s)", flush=True)
    if not history:
        return pd.concat(rows, ignore_index=True), pd.concat(matches, ignore_index=True)

    # history: one query per day, for the 30 days before each target day
    hist_days = sorted({d - timedelta(days=k) for d in wanted for k in range(1, HISTORY_DAYS + 1)})
    done = lambda h: final(h) and (CACHE / f"ph_{h}.parquet").exists() and (CACHE / f"hp_{h}.parquet").exists()
    todo = [h for h in hist_days if not done(h)]
    if todo:
        print(f"Player and hero-pair history: {len(todo)} day(s) to fetch…", flush=True)
    for h in todo:
        t0 = time.time()
        raw = HISTORY_RAW_SQL.format(day=h, next_day=h + timedelta(days=1), min_duration=MIN_DURATION_S)

        def run(c, raw=raw):
            c.execute(f"CREATE OR REPLACE TEMP TABLE ph_raw AS {raw}")
            a, b = c.execute(PLAYER_HERO_SQL).df(), c.execute(HERO_PAIR_SQL).df()
            c.execute("DROP TABLE ph_raw")
            return a, b
        res = _query(con, run, f"history {h}", timeout=1200)
        if res is None:
            continue
        ph = res[0].astype({"account_id": "int64", "hero_id": "int16", "n": "int32", "wins": "int32", "spm": "float32"})
        _save(ph, CACHE / f"ph_{h}.parquet")
        _save(res[1].astype({"h1": "int16", "h2": "int16", "n": "int32", "wins": "int32"}), CACHE / f"hp_{h}.parquet")
        print(f"  history {h}: {len(ph):,} player-hero pairs ({time.time() - t0:.0f}s)", flush=True)

    # drop only old files: another run may use a longer window (e.g. the evaluation)
    oldest = str(today - timedelta(days=KEEP_CACHE_DAYS))
    for pat in ("wf_*", "wfm_*", "ph_*", "hp_*"):
        for f in CACHE.glob(f"{pat}.parquet"):
            if f.stem.split("_", 1)[1] < oldest:
                f.unlink()
    for f in CACHE.glob("hh_*.parquet"):          # replaced by ph_*
        f.unlink()
    return pd.concat(rows, ignore_index=True), pd.concat(matches, ignore_index=True)


def _compact(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for c in [*FEATURES, *EXTRA_COLS]:
        if c in df:
            df[c] = df[c].astype("float32")
    for c in FLAGS:
        if c in df:
            df[c] = df[c].astype("int8")
    df["minute"] = df["minute"].astype("int16")
    df["team0_won"] = df["team0_won"].astype(bool)
    return df


# ---------------------------------------------------------------------------
# Derived factors
# ---------------------------------------------------------------------------
def _window(before, prefix: str) -> list:
    """Cache files `prefix`<day> for the look-back window strictly before `before`.
    The window is cut at the latest patch when that patch is old enough."""
    from pipeline.patches import history_start, load
    start = str(history_start(before, HISTORY_DAYS, load()))
    k = len(prefix)
    return sorted(f for f in CACHE.glob(f"{prefix}*.parquet") if start <= f.stem[k:] < str(before))


def hero_priors(before) -> tuple[dict, dict, str]:
    """Per-hero scaling index and win rate from Phase 1 daily counts in the 30
    days strictly before `before`, so the draft factors never use the matches
    being explained (or anything later)."""
    from pipeline.stats import power_curves, scaling_index
    files = _window(before, "counts_")
    if files:
        c = (pd.concat([pd.read_parquet(f) for f in files])
               .groupby(["hero_id", "bucket_idx"], as_index=False)[["wins", "games"]].sum())
        idx = scaling_index(power_curves(c))
        src = f"{len(files)} days of matches before {before}"
    else:
        idx = pd.read_parquet(DATA_DIR / "scaling_index.parquet").query(
            "queue=='all' and rank=='all' and period=='all'")
        src = "data/scaling_index.parquet (overlaps the analysis window; run pipeline.build first)"
        print(f"warning: draft priors from {src}")
    # the model was trained on the plain slope; the strength-adjusted one is for the Phase 1 pages
    col = "raw_pp_per_10min" if "raw_pp_per_10min" in idx else "pp_per_10min"
    return dict(zip(idx["hero_id"], idx[col])), dict(zip(idx["hero_id"], idx["win_rate"])), src


def pair_effects(pairs: pd.DataFrame, prior: float = PAIR_PRIOR) -> tuple[np.ndarray, np.ndarray]:
    """Hero-pair effects beyond the heroes' own win rates, from pair counts
    (h1 < h2, same, n, wins of h1's side). Returns 256x256 matrices:
      S[a, b]: together on a team, how much better than their two win rates suggest
      C[a, b]: a against b, how much better a's side does than the win rates suggest
    Both are shrunk toward 0 by `prior` pseudo-games; C[b, a] = -C[a, b]."""
    S, C = np.zeros((256, 256)), np.zeros((256, 256))
    if pairs.empty:
        return S, C
    p = pairs.groupby(["h1", "h2", "same"], as_index=False)[["n", "wins"]].sum()
    x = p[~p["same"]]                                   # hero win rates from the same matches
    games, wins = np.zeros(256), np.zeros(256)
    np.add.at(games, x["h1"], x["n"]); np.add.at(wins, x["h1"], x["wins"])
    np.add.at(games, x["h2"], x["n"]); np.add.at(wins, x["h2"], x["n"] - x["wins"])
    a = np.where(games > 0, wins / np.maximum(games, 1) - 0.5, 0.0)
    h1, h2, n = p["h1"].to_numpy(), p["h2"].to_numpy(), p["n"].to_numpy(float)
    same = p["same"].to_numpy()
    expected = 0.5 + a[h1] + np.where(same, a[h2], -a[h2])
    eff = (p["wins"].to_numpy() / n - expected) * n / (n + prior)
    S[h1[same], h2[same]] = eff[same]; S[h2[same], h1[same]] = eff[same]
    C[h1[~same], h2[~same]] = eff[~same]; C[h2[~same], h1[~same]] = -eff[~same]
    return S, C


def pair_priors(before) -> tuple[np.ndarray, np.ndarray]:
    files = _window(before, "hp_")
    if not files:
        print(f"warning: {before}: no hero-pair history; draft synergy and counters are 0")
        return pair_effects(pd.DataFrame())
    return pair_effects(pd.concat([pd.read_parquet(f) for f in files]))


def pair_features(matches: pd.DataFrame, S: np.ndarray, C: np.ndarray) -> pd.DataFrame:
    """Draft synergy (15 same-team pairs per team, team0 minus team1) and draft
    counters (36 cross pairs), in percentage points."""
    h0 = np.array(matches["heroes0"].tolist(), dtype=int)
    h1 = np.array(matches["heroes1"].tolist(), dtype=int)
    k = h0.shape[1]
    syn = np.zeros(len(matches)); cnt = np.zeros(len(matches))
    for i in range(k):
        for j in range(i + 1, k):
            syn += S[h0[:, i], h0[:, j]] - S[h1[:, i], h1[:, j]]
        for j in range(k):
            cnt += C[h0[:, i], h1[:, j]]
    return pd.DataFrame({"match_id": matches["match_id"].to_numpy(), "draft_synergy": syn * 100,
                         "draft_counter": cnt * 100})


def draft_features(matches: pd.DataFrame, scale: dict, wr: dict) -> pd.DataFrame:
    s = lambda hs: sum(scale.get(int(h), 0.0) for h in hs)
    w = lambda hs: sum((wr.get(int(h), 0.5) - 0.5) * 100 for h in hs)
    return pd.DataFrame({
        "match_id": matches["match_id"].to_numpy(),
        "draft_scaling": [s(a) - s(b) for a, b in zip(matches["heroes0"], matches["heroes1"])],
        "draft_strength": [w(a) - w(b) for a, b in zip(matches["heroes0"], matches["heroes1"])],
    })


def player_features(matches: pd.DataFrame, days: pd.Series) -> pd.DataFrame:
    """Pre-game player factors from the 30 days before the match day (never the
    day itself), each as team0's average minus team1's:
      hero_experience: games on the picked hero, capped
      player_form:     win rate over all heroes, pulled toward 50%
      player_farm:     souls per minute over all heroes, pulled toward the average
      hero_mastery:    win rate on the picked hero, pulled toward 50%
    Players without history count as average."""
    import duckdb
    con = duckdb.connect()
    cols = ["hero_experience", "player_form", "player_farm", "hero_mastery"]
    m = matches.merge(days.rename("day").reset_index(), on="match_id")
    out = []
    for day, g in m.groupby("day"):
        files = [f.as_posix() for f in _window(day.date(), "ph_")]
        if len(files) < HISTORY_DAYS:
            print(f"warning: {day.date()}: only {len(files)} of {HISTORY_DAYS} history days available")
        if not files:
            out.append(pd.DataFrame({"match_id": g["match_id"], **{c: 0.0 for c in cols}}))
            continue
        hist = con.execute(f"SELECT account_id, hero_id::BIGINT AS hero_id, sum(n) AS n, sum(wins) AS wins, "
                           f"sum(spm) AS spm FROM read_parquet({files!r}) GROUP BY ALL").df()
        acct = hist.groupby("account_id", as_index=False)[["n", "wins", "spm"]].sum() \
                   .rename(columns={"n": "N", "wins": "W", "spm": "SPM"})
        avg_spm = float(hist["spm"].sum() / max(hist["n"].sum(), 1))
        teams = []
        for t in (0, 1):
            x = g[["match_id", f"heroes{t}", f"accounts{t}"]].explode([f"heroes{t}", f"accounts{t}"])
            x.columns = ["match_id", "hero_id", "account_id"]
            teams.append(x.assign(team=t))
        x = pd.concat(teams).astype({"hero_id": "int64", "account_id": "int64"})
        x = x.merge(hist[["account_id", "hero_id", "n", "wins"]], on=["account_id", "hero_id"], how="left") \
             .merge(acct, on="account_id", how="left").fillna(0.0)
        x["hero_experience"] = x["n"].clip(upper=EXPERIENCE_CAP)
        x["player_form"] = ((x["W"] + FORM_PRIOR / 2) / (x["N"] + FORM_PRIOR) - 0.5) * 100
        x["player_farm"] = (x["SPM"] + FARM_PRIOR * avg_spm) / (x["N"] + FARM_PRIOR)
        x["hero_mastery"] = ((x["wins"] + MASTERY_PRIOR / 2) / (x["n"] + MASTERY_PRIOR) - 0.5) * 100
        e = x.groupby(["match_id", "team"])[cols].mean().unstack()
        res = pd.DataFrame({c: (e[(c, 0)] - e[(c, 1)]).to_numpy() for c in cols})
        res.insert(0, "match_id", e.index.to_numpy())
        out.append(res)
    return pd.concat(out, ignore_index=True)


def prepare(rows: pd.DataFrame, matches: pd.DataFrame) -> tuple[pd.DataFrame, str]:
    """Add the factors computed in Python: draft and player history."""
    days = rows.drop_duplicates("match_id").set_index("match_id")["day"]
    # priors per match day: only the days before that day
    drafts, srcs = [], []
    m = matches.merge(days.rename("day").reset_index(), on="match_id")
    for day, g in m.groupby("day"):
        scale, wr, src = hero_priors(day.date())
        drafts.append(draft_features(g, scale, wr).merge(pair_features(g, *pair_priors(day.date())), on="match_id"))
        srcs.append(f"{day.date()}: {src}")
    src = "per match day, from the 30 days before it (" + "; ".join(srcs[:1] + (["…"] if len(srcs) > 1 else [])) + ")"
    extra = pd.concat(drafts, ignore_index=True).merge(player_features(matches, days), on="match_id")
    for c in DERIVED:
        extra[c] = extra[c].astype("float32")
    rows = rows.merge(extra, on="match_id", how="inner")
    return rows, src


def make_demo(n_matches: int = 30_000, seed: int = 3) -> pd.DataFrame:
    """Synthetic snapshots with known weights, for an offline UI and a recovery test."""
    rng = np.random.default_rng(seed)
    minutes = [3, 6, 9, 12, 15, 20, 25, 30, 35, 40]
    true = {"souls": 0.9, "kills": 0.25, "walkers": 0.35, "mid_boss": 0.3}
    rows = []
    strength = rng.normal(0, 1, n_matches)
    for mnt in minutes:
        g = np.sqrt(mnt / 15)
        souls = (strength * 3000 + rng.normal(0, 2500, n_matches)) * g
        kills = souls / 900 + rng.normal(0, 4, n_matches) * g
        walkers = np.clip(np.round(souls / 6000 + rng.normal(0, 0.6, n_matches)), -3, 3) * (mnt >= 12)
        mid = np.where(mnt >= 20, np.sign(strength + rng.normal(0, 1.5, n_matches)), 0) * (rng.random(n_matches) < 0.6)
        rows.append(pd.DataFrame({"match_id": np.arange(n_matches), "minute": mnt, "souls": souls,
                                  "kills": kills, "walkers": walkers, "mid_boss": mid}))
    df = pd.concat(rows, ignore_index=True)
    for c in FEATURES:
        if c not in df:
            df[c] = 0.0
    final = df[df["minute"] == 40]
    z = sum(w * final[c] / final[c].std() for c, w in true.items())
    won = rng.random(n_matches) < 1 / (1 + np.exp(-z.to_numpy()))
    df["team0_won"] = won[df["match_id"]]
    df["queue"] = np.where(df["match_id"] % 3 == 0, "Ranked", "Unranked")
    df["rank"] = np.where(df["queue"] == "Ranked", np.array(["low", "mid", "high"])[df["match_id"] % 3], "none")
    df.attrs["true"] = true
    return df


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
def logit_fit(X: np.ndarray, y: np.ndarray, ridge: float = 1e-3, iters: int = 50):
    """Logistic regression by Newton-Raphson. X includes an intercept column.
    Returns coefficients and standard errors (from the inverse Hessian)."""
    beta = np.zeros(X.shape[1])
    pen = np.full(X.shape[1], ridge); pen[0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(X @ beta, -30, 30)))
        w = p * (1 - p)
        H = (X * w[:, None]).T @ X + np.diag(pen)
        step = np.linalg.solve(H, X.T @ (y - p) - pen * beta)
        beta += step
        if np.max(np.abs(step)) < 1e-8:
            break
    p = 1 / (1 + np.exp(-np.clip(X @ beta, -30, 30)))
    H = (X * (p * (1 - p))[:, None]).T @ X + np.diag(pen)
    return beta, np.sqrt(np.diag(np.linalg.inv(H)))


def _auc(y, p):
    order = np.argsort(p)
    ranks = np.empty(len(p)); ranks[order] = np.arange(1, len(p) + 1)
    pos = y.sum()
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * (len(y) - pos)))


def _sig(x):
    return 1 / (1 + np.exp(-x))


def analyse_minute(d: pd.DataFrame, feats: list[str] = FEATURES):
    """feats: factors available in this slice (rank exists for ranked games only)."""
    y = d["team0_won"].to_numpy(float)
    test = (d["match_id"].to_numpy() % TEST_SHARE) == 0
    tr = ~test
    sd = {c: float(d.loc[tr, c].std()) for c in FEATURES}
    used = [c for c in feats if sd[c] > 1e-9 and (d.loc[tr, c] != 0).mean() > 0.001]
    Z = np.column_stack([np.ones(len(d))] + [d[c].to_numpy(float) / sd[c] for c in used])
    beta, se = logit_fit(Z[tr], y[tr])
    p_test = _sig(Z[test] @ beta)
    yt = y[test]
    eps = 1e-12
    metrics = {
        "accuracy": float(((p_test > 0.5) == yt).mean()),
        "auc": _auc(yt, p_test),
        "log_loss": float(-np.mean(yt * np.log(p_test + eps) + (1 - yt) * np.log(1 - p_test + eps))),
        "brier": float(np.mean((p_test - yt) ** 2)),
        "base_log_loss": float(np.log(2)),   # coin flip, for reference
    }
    factors = []
    for c in FEATURES:
        if c not in feats:
            factors.append({"id": c, "available": False, "sd": None, "lead_share": 0.0, "lead_n": 0,
                            "lead_win_rate": None, "lead_ci_low": None, "lead_ci_high": None,
                            "effect_pp": None, "ci_low": None, "ci_high": None, "beta": None, "se": None})
            continue
        x = d[c].to_numpy()
        lead = x != 0
        ahead_won = np.where(x > 0, y, 1 - y)[lead]
        n_lead = int(lead.sum())
        row = {"id": c, "available": True, "sd": sd[c], "lead_share": float(lead.mean()), "lead_n": n_lead,
               "lead_win_rate": float(ahead_won.mean()) if n_lead else None,
               "lead_ci_low": None, "lead_ci_high": None,
               "effect_pp": None, "ci_low": None, "ci_high": None, "beta": None, "se": None}
        if n_lead:
            lo, hi = wilson(ahead_won.sum(), n_lead)
            row.update(lead_ci_low=float(lo), lead_ci_high=float(hi))
        if c in used:
            j = used.index(c) + 1
            b, s = beta[j], se[j]
            row.update(beta=float(b), se=float(s), effect_pp=float((_sig(b) - 0.5) * 100),
                       ci_low=float((_sig(b - Z95 * s) - 0.5) * 100), ci_high=float((_sig(b + Z95 * s) - 0.5) * 100))
            k = STEP[c][0] / sd[c]          # standardised units in one plain step
            row.update(step_pp=float((_sig(b * k) - 0.5) * 100),
                       step_ci_low=float((_sig((b - Z95 * s) * k) - 0.5) * 100),
                       step_ci_high=float((_sig((b + Z95 * s) * k) - 0.5) * 100))
        factors.append(row)
    return metrics, factors, (p_test, yt), int(tr.sum()), int(test.sum()), correlations(d, feats)


def correlations(d: pd.DataFrame, feats: list[str] = FEATURES) -> dict:
    """Pearson correlations between the factor differences and the result
    (team0 won = 1), over all matches at this minute. Constant columns -> None."""
    cols = ["won"] + FEATURES
    M = np.column_stack([d["team0_won"].to_numpy(float)] + [d[c].to_numpy(float) for c in FEATURES])
    ok = (M.std(axis=0) > 1e-12) & np.array([True] + [c in feats for c in FEATURES])
    r = np.full((len(cols), len(cols)), np.nan)
    r[np.ix_(ok, ok)] = np.corrcoef(M[:, ok], rowvar=False)
    return {"vars": cols, "r": [[None if np.isnan(v) else round(float(v), 4) for v in row] for row in r]}


def calibration(p: np.ndarray, y: np.ndarray, bins: int = 10):
    out = []
    idx = np.minimum((p * bins).astype(int), bins - 1)
    for b in range(bins):
        m = idx == b
        n = int(m.sum())
        if n < 50:
            continue
        lo, hi = wilson(y[m].sum(), n)
        out.append({"bin": b, "mean_pred": float(p[m].mean()), "observed": float(y[m].mean()),
                    "ci_low": float(lo), "ci_high": float(hi), "n": n})
    return out


def analyse(df: pd.DataFrame) -> dict:
    slices = {}
    for q, r in QUEUE_RANK:
        s = df
        if q != "all":
            s = s[s["queue"].str.lower() == q]
        if r != "all":
            s = s[s["rank"] == r]
        feats = FEATURES if q == "ranked" else [c for c in FEATURES if c not in RANKED_ONLY]
        minutes, preds = [], []
        for mnt, d in s.groupby("minute"):
            if d["match_id"].nunique() < MIN_MATCHES:
                continue
            metrics, factors, pred, n_tr, n_te, corr = analyse_minute(d, feats)
            preds.append(pred)
            minutes.append({"minute": int(mnt), "matches": int(d["match_id"].nunique()),
                            "train": n_tr, "test": n_te, "metrics": metrics, "factors": factors,
                            "corr": corr})
        if not minutes:
            continue
        p = np.concatenate([x[0] for x in preds]); y = np.concatenate([x[1] for x in preds])
        slices[f"{q}|{r}"] = {"minutes": minutes, "calibration": calibration(p, y),
                              "matches": int(s["match_id"].nunique())}
    return slices


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--days", type=int, default=2, help="complete UTC days to use")
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()

    if args.demo:
        df, source, priors = make_demo(), "demo", "demo"
    else:
        print(f"Pulling snapshot data for the last {args.days} complete days…", flush=True)
        rows, matches = fetch_days(args.days, args.refresh)
        df, priors = prepare(rows, matches)
        source = "deadlock-api data lake"
    print(f"{df['match_id'].nunique():,} matches, {len(df):,} match-minute rows; fitting…", flush=True)
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source, "days": args.days,
        "factors": [{"id": i, "label": l, "unit": u, "description": d, "group": g, "step": STEP[i][1],
                     "ranked_only": i in RANKED_ONLY} for i, l, u, d, g in FACTORS],
        "draft_priors": priors,
        "min_matches": MIN_MATCHES,
        "slices": analyse(df),
    }
    (DATA_DIR / "win_factors.json").write_text(json.dumps(out), encoding="utf-8")
    a = out["slices"]["all|all"]
    m15 = next((m for m in a["minutes"] if m["minute"] == 15), a["minutes"][0])
    top = sorted((f for f in m15["factors"] if f["effect_pp"] is not None), key=lambda f: -abs(f["effect_pp"]))[:4]
    print(f"minute {m15['minute']}: held-out accuracy {m15['metrics']['accuracy']:.1%}, AUC {m15['metrics']['auc']:.3f}")
    print("  top unique weights:", ", ".join(f"{f['id']} {f['effect_pp']:+.1f}pp" for f in top))
    print(f"Wrote {DATA_DIR / 'win_factors.json'}")


if __name__ == "__main__":
    main()
