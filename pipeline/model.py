"""One win model for the whole game.

Instead of separate logistic fits per snapshot minute, a single
gradient-boosted model takes game time as an input, so it gives a win chance
at any moment, which the per-match win-probability graph needs.

  * Linear score: logistic weights are fit at every game minute with enough
    matches and interpolated in between; their score is one input. The factors
    act almost linearly, so this carries most of the signal and the trees only
    add what the straight lines miss. Ranked and unranked matches get their own
    weight tables (a ranked-only model beat the shared one on ranked matches by
    0.005 log loss), and ranked matches also use the teams' rank gap.
  * Monotone constraints, only where the data agree: a factor is constrained
    (a bigger lead never lowers the trees' output) when its logistic weight is
    positive at every minute. Factors whose weight turns negative once the
    others are known (e.g. damage at equal souls and kills), and style factors
    (momentum, carry concentration, draft scaling), are left free.
  * Relative lead: the souls lead as a share of all souls in the game.
  * Context: game minute, total souls, the queue (ranked, low-priority,
    new-player, wide-skill party) and how old the player stats are (the lake
    only has them every 3-5 minutes; live data is fresh, so pass stale = 0).
    These say nothing about which team is ahead, but let the model be more or
    less sure in each situation.
  * Team flip: every training row is also added with the teams swapped, and
    predictions average both views, so the model treats the sides the same.
  * Recalibration: an isotonic map fit on matches the model never trained on
    (kept symmetric as well).

Two feature sets:
  * full (default): every factor; for finished matches, where the lake or the
    match-metadata API has per-player stats and death times.
  * LIVE_DIFFS: only what the live-matches API exposes while a game is running
    (team souls, objectives, heroes, players, abandons).

Tested and rejected (10 days, newest day held out): constraining every factor
(log loss +0.003, +0.013 at minute 45), dropping the near-duplicates hero
levels and enemy time dead (+0.005 at minute 45), more trees, 3x more matches.
"""
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression

from pipeline.win_factors import FACTORS, FLAGS, SNAP_MIN, logit_fit

DIFFS = [f[0] for f in FACTORS]                                  # rank_gap counts in ranked matches only
RANKED_ONLY_DIFFS = {"rank_gap"}
# https://api.deadlock-api.com/v1/matches/active: net_worth_team_0/1, objectives_mask_team0/1,
# players[].hero_id / account_id / abandoned, start_time, match_mode, low_pri_pool
LIVE_DIFFS = ["souls", "guardians", "walkers", "base_guardians", "shrines", "open_lanes", "deepest_push",
              "enemy_abandons", "draft_scaling", "draft_strength", "draft_synergy", "draft_counter",
              "hero_experience", "player_form", "player_farm", "hero_mastery"]
# The live broadcast stream (/v1/matches/demo/live/query) has current per-player stats and
# objective state for any match in progress, but not these: souls dropped on death, total
# time spent dead, Mid-Boss claims, and the lobby's rank averages. Its last-hit counter is a
# different statistic (about 1.6x the lake's creep + neutral kills at the same game time), so
# last hits are left out too.
STREAM_DIFFS = [d for d in DIFFS if d not in {"enemy_souls_lost", "enemy_dead_time", "mid_boss", "rank_gap", "last_hits"}]
FREE = {"momentum", "carry_concentration", "draft_scaling"}      # never constrained
CONTEXT = ["minute", "total_souls", "stale", "ranked", *FLAGS]   # same for both teams
P_CLIP = 1e-4
MIN_ROWS = 2000                                                  # per minute, to fit linear weights
_SNAPS = np.array([0] + SNAP_MIN)


def staleness(minute: np.ndarray) -> np.ndarray:
    """Minutes since the last stats snapshot in the lake (0 at a snapshot minute)."""
    m = np.asarray(minute, float)
    return m - _SNAPS[np.searchsorted(_SNAPS, m, side="right") - 1]


def _ranked(df: pd.DataFrame) -> np.ndarray:
    return (df["queue"].str.lower() == "ranked").to_numpy() if "queue" in df else np.zeros(len(df), bool)


class WinModel:
    def __init__(self, diffs: list[str] | None = None, max_iter: int = 500, seed: int = 0):
        self.diffs = list(diffs or DIFFS)
        self.feats = self.diffs + ["souls_rel", "linear"] + CONTEXT
        self.mirrored = [i for i, f in enumerate(self.feats) if f not in CONTEXT]   # change sign when teams swap
        self.max_iter, self.seed = max_iter, seed
        self.clf: HistGradientBoostingClassifier | None = None
        self.iso: IsotonicRegression | None = None
        # linear weights per queue (False = unranked, True = ranked): (minutes, minute x factor weights)
        zero = (np.array([0.0]), np.zeros((1, len(self.diffs))))
        self.tables = {False: zero, True: zero}
        self.monotone = [0] * len(self.feats)

    def flip(self, X: np.ndarray) -> np.ndarray:
        X = X.copy()
        X[:, self.mirrored] *= -1
        return X

    # -- linear part -------------------------------------------------------
    def _diff(self, df: pd.DataFrame, c: str, ranked: np.ndarray) -> np.ndarray:
        x = df[c].to_numpy(float) if c in df else np.zeros(len(df))
        return np.where(ranked, x, 0.0) if c in RANKED_ONLY_DIFFS else x

    def _table(self, d: pd.DataFrame):
        """Logistic weights per game minute; the intercept is dropped (teams are interchangeable)."""
        mins, W = [], []
        ranked = _ranked(d)
        for mnt in np.sort(d["minute"].unique()):
            k = (d["minute"] == mnt).to_numpy()
            if k.sum() < MIN_ROWS:
                continue
            g = d[k]
            X = np.column_stack([self._diff(g, c, ranked[k]) for c in self.diffs])
            sd = X.std(axis=0)
            ok = (sd > 1e-9) & ((X != 0).mean(axis=0) > 0.001)
            Z = np.column_stack([np.ones(len(g)), X[:, ok] / sd[ok]])
            beta, _ = logit_fit(Z, g["team0_won"].to_numpy(float))
            w = np.zeros(len(self.diffs))
            w[ok] = beta[1:] / sd[ok]
            mins.append(float(mnt))
            W.append(w)
        return (np.array(mins), np.array(W)) if mins else None

    def _fit_linear(self, train: pd.DataFrame):
        ranked = _ranked(train)
        shared = self._table(train)
        if shared is None:
            return
        for q in (False, True):
            own = self._table(train[ranked == q]) if (ranked == q).any() else None
            self.tables[q] = own or shared

    def linear(self, df: pd.DataFrame) -> np.ndarray:
        """Linear score at any game minute: the queue's weights, interpolated between fitted minutes."""
        t = df["minute"].to_numpy(float)
        ranked = _ranked(df)
        out = np.zeros(len(df))
        for q in (False, True):
            k = ranked == q
            if not k.any():
                continue
            mins, W = self.tables[q]
            g = df[k]
            for j, c in enumerate(self.diffs):
                out[k] += self._diff(g, c, ranked[k]) * np.interp(t[k], mins, W[:, j])
        return out

    def features(self, df: pd.DataFrame) -> np.ndarray:
        n = len(df)
        col = lambda c: df[c].to_numpy(np.float32) if c in df else np.zeros(n, np.float32)
        ranked = _ranked(df)
        total = df["total_souls"].to_numpy(np.float32) if "total_souls" in df else np.full(n, np.nan, np.float32)
        stale = col("stale") if "stale" in df else staleness(col("minute")).astype(np.float32)
        ctx = {"minute": col("minute"), "total_souls": total, "stale": stale, "ranked": ranked.astype(np.float32),
               **{f: col(f) for f in FLAGS}}
        rel = col("souls") / np.maximum(total, 1.0)
        return np.column_stack([self._diff(df, c, ranked).astype(np.float32) for c in self.diffs]
                               + [rel, self.linear(df).astype(np.float32)] + [ctx[c] for c in CONTEXT])

    # -- fit / predict -----------------------------------------------------
    def fit(self, train: pd.DataFrame, calib: pd.DataFrame, max_matches: int = 400_000) -> "WinModel":
        self._fit_linear(train)                            # cheap: uses every training match
        # constrain a factor only if its weight is never negative, in either queue (and positive somewhere)
        W = np.vstack([self.tables[False][1], self.tables[True][1]])
        positive = dict(zip(self.diffs, (W >= 0).all(axis=0) & (W > 0).any(axis=0)))
        positive["souls_rel"], positive["linear"] = positive["souls"], True
        self.monotone = [int(f not in CONTEXT and f not in FREE and bool(positive[f])) for f in self.feats]

        ids = train["match_id"].unique()
        if len(ids) > max_matches:                         # sample whole matches, never single rows
            keep = np.random.default_rng(self.seed).choice(ids, max_matches, replace=False)
            train = train[train["match_id"].isin(keep)]
        self.clf = HistGradientBoostingClassifier(
            loss="log_loss", learning_rate=0.08, max_iter=self.max_iter, max_leaf_nodes=63,
            min_samples_leaf=400, l2_regularization=1.0, monotonic_cst=self.monotone,
            early_stopping=True, validation_fraction=0.1, n_iter_no_change=20, random_state=self.seed)
        X, y = self.features(train), train["team0_won"].to_numpy(np.float32)
        self.clf.fit(np.vstack([X, self.flip(X)]), np.concatenate([y, 1 - y]))
        self.n_train_matches = int(train["match_id"].nunique())
        self.n_train_rows = int(len(train))
        # symmetric isotonic recalibration on held-back matches
        p, yc = self.predict_raw(calib), calib["team0_won"].to_numpy(float)
        self.iso = IsotonicRegression(out_of_bounds="clip", y_min=P_CLIP, y_max=1 - P_CLIP)
        self.iso.fit(np.concatenate([p, 1 - p]), np.concatenate([yc, 1 - yc]))
        return self

    def predict_raw(self, df: pd.DataFrame) -> np.ndarray:
        X = self.features(df)
        p = self.clf.predict_proba(X)[:, 1]
        q = self.clf.predict_proba(self.flip(X))[:, 1]
        return np.clip((p + 1 - q) / 2, P_CLIP, 1 - P_CLIP)

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        p = self.predict_raw(df)
        return np.clip(self.iso.predict(p), P_CLIP, 1 - P_CLIP) if self.iso is not None else p

    def info(self) -> dict:
        return {"features": self.feats, "monotone": dict(zip(self.feats, self.monotone)),
                "constrained": [f for f, m in zip(self.feats, self.monotone) if m],
                "free": [f for f, m in zip(self.feats, self.monotone) if not m and f not in CONTEXT],
                "context": CONTEXT, "linear_minutes": [int(m) for m in self.tables[False][0]],
                "ranked_table": self.tables[True] is not self.tables[False],
                "iterations": int(self.clf.n_iter_), "train_matches": self.n_train_matches,
                "train_rows": self.n_train_rows}
