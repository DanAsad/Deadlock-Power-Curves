# Deadlock analytics: hero power curves → win-probability model

Portfolio project on Deadlock match data from the free
[Deadlock API](https://deadlock-api.com) public data lake. Not affiliated with Valve.

**Phase 1 (this repo):** win rate by game length for every hero, with 95%
confidence intervals and a scaling index (early-game vs late-game), browsable in
a web app with patch / queue / rank filters.

## Layout

```
pipeline/   Python jobs: query the lake with DuckDB → small tables in data/
api/        FastAPI: serves data/ with filter params (+ the built frontend)
web/        React + Vite + TypeScript frontend
data/       precomputed tables (power_curves.parquet, scaling_index.parquet, heroes.json, meta.json)
schema.md   data lake tables and columns, with findings
```

## Quick start

```bash
python -m venv .venv && .venv\Scripts\activate      # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cd web && npm install && cd ..

python -m pipeline.build --demo        # synthetic data, offline, ~5 s
# or: python -m pipeline.build --days 30   (real matches, ~15 min first time)
python -m pipeline.win_factors --days 2   # "What wins games" tab (or --demo), ~2 min

uvicorn api.main:app --reload --port 8000   # terminal 1
cd web && npm run dev                       # terminal 2 → http://localhost:5173
```

Production-style: `cd web && npm run build`, then `uvicorn api.main:app` serves
the app and the API together on one port.

Tests: `python -m pytest pipeline api`. The demo test plants known per-hero
scaling slopes in synthetic matches and checks the scaling index recovers them
(correlation > 0.95).

## Online version (GitHub Pages)

Live at https://danasad.github.io/Deadlock-Power-Curves/. GitHub Pages has no
backend, so on every push to `main` the workflow in `.github/workflows/pages.yml`
builds the frontend in static mode (`VITE_STATIC=1`) and runs
`python -m api.export_static`, which writes every API response as a JSON file
from the committed tables in `data/`. To refresh the numbers online: rerun the
pipeline locally, commit `data/`, push.

## Data

- Lake: `https://data.deadlock-api.com/v1/catalog.ducklake` (DuckLake, read-only,
  hourly). Connection in `pipeline/lake.py`. If it breaks, copy the current
  snippet from <https://deadlock-api.com/data-dumps>.
- Schema: `python -m pipeline.explore_schema` regenerates `schema.md`.
- The pull runs one UTC day at a time (timeout + retries per day) and caches
  each day's aggregated counts in `data/cache/`. Reruns only fetch new days and
  the last two (still filling in); `--refresh` refetches everything. One big
  30-day query over HTTP hung on a stalled connection, hence the chunking.
- One table, `match_player`, holds one row per player per match with the match
  fields repeated, plus per-player time series (`stats.*` arrays).
- Kept: Normal 6v6, Ranked + Unranked, scored, ≥ 8 minutes, complete matches
  (12 players, 6 winners), deduplicated on (match_id, hero_id).
- Rank brackets use `average_badge` (Ranked only). Patches are date ranges in
  `pipeline/config.py` (`PATCHES`). The lake has no patch column.
- Hero names/images: `https://api.deadlock-api.com/v1/assets/heroes`.

## Method

- Game length is cut into 5-minute buckets (<20 … 50+). Per hero and bucket:
  win rate with a 95% **Wilson** interval. Buckets under 300 games are hidden.
- **Scaling index**: inverse-variance weighted least-squares slope of win rate
  on bucket midpoint, in percentage points per extra 10 minutes, with a 95% CI.
  Needs ≥ 3 shown buckets. Early/late labels are used only when the CI excludes 0.
- **Caveat:** game length is an outcome, not a clock. A hero that wins short
  games may be strong early, or may just win stomps (which end sooner). The
  lake's `stats.*` snapshots allow the better measure next: soul share and
  kill participation *at* minute X.

## What wins games

`pipeline/win_factors.py` builds one row per match per game minute, with each
factor as a team difference known at that time. Stats snapshots exist every 3
minutes to 15:00 and every 5 after; every match gets a row at those minutes,
and a 1-in-5 sample of matches gets a row at every minute from 1 to 45.

- **Economy:** souls, hero levels, last hits, denies, soul-lead momentum
  (change between the two latest snapshots, per 5 min), carry concentration
  (richest player's share of team souls).
- **Fights:** kills, hero damage, enemies dead right now, enemy respawn time
  left, enemy time dead so far, enemy souls lost on death, enemy leavers.
- **Objectives:** Guardians, Walkers, Base Guardians, Shrines, Mid-Boss
  claims, objective damage, and the map state per lane: open lanes (enemy lost
  both Guardian and Walker in a lane) and deepest push (most objectives taken
  in one lane).
- **Pre-game:** draft strength and draft scaling (sum of the heroes' win rate
  and scaling index), draft synergy and draft counters (how hero pairs do
  together and against each other beyond their own win rates, shrunk toward
  zero), hero experience, win rate on the picked hero, the players' recent win
  rate and souls per minute, and the rank gap (ranked games only).

Leakage rules: every pre-game number comes only from the 30 days *before* the
match day (cut at the latest patch once that patch is a week old; cached per
day as `data/cache/ph_*` and `hp_*`). The game-end snapshot and the Patron/Core
objectives are dropped. Between snapshots a player's last snapshot is carried
forward, never interpolated toward the next one: interpolating leaked the
future (a model fed interpolated stats scored better just after a snapshot than
at it). Objectives, deaths and respawn timers come from event times and are
exact at every minute. The lake's `party` column is empty, so premade groups
can't be measured.

- **On its own:** win rate of the team ahead in each factor (Wilson 95% CI).
- **Unique weight:** logistic regression on standardised differences, per
  minute and filter slice, shown as the win chance a 1-SD lead gives an even
  game, holding the other factors fixed (95% CI from the Hessian). Also given
  per plain step (1 Walker, 1,000 souls, 1 enemy leaver, ...).
- **Held-out check** (20% of matches, split by match): accuracy, AUC, log
  loss, Brier score, calibration curve.
- **Correlation heatmap:** Pearson correlations between the factor
  differences (and the result) per minute. It shows which leads overlap, e.g.
  souls and hero levels at r ≈ 0.98, so their unique weights share credit.

This is the first step toward Phase 2: the same rows are the training data.

## Model check

`python -m pipeline.evaluate --days 10` measures the team prediction on matches
it never saw, written to `data/model_eval.json` and shown on the Model check page.

- **Splits, both by match:** newest day held out (train on the earlier days,
  like a live system) and a random 20% of matches.
- **Baselines:** coin flip, souls-lead-only, and the per-minute model on the
  factor set from before step 3, against all factors.
- **Drop-one-group tests:** refit without economy / fights / objectives /
  pre-game; the share of the model's gain over a coin flip lost without each,
  with a paired 95% CI on the same test matches.
- **Per minute:** log loss, Brier score, accuracy, AUC, calibration curve and
  its error (ECE).
- Draft priors are recomputed per match day from the 30 days before it, so the
  held-out day never uses hero stats from itself or later.

Every model change from here on should be judged by these numbers.

### One model for the whole game (`pipeline/model.py`)

A single gradient-boosted model (scikit-learn `HistGradientBoostingClassifier`)
replaces the 11 per-minute logistic fits, so it can give a win chance at any
moment of a match:

- **Game time and total souls as inputs**, plus the souls lead as a share of
  all souls (a 5k lead means more at minute 10 than at 40), the queue (ranked,
  low-priority, new-player, wide-skill party) and how old the stats are.
- **Linear score as an input:** the per-minute logistic weights are kept as a
  table and interpolated between snapshot minutes; the trees add only what the
  straight lines miss.
- **Monotone constraints where the data agree:** a factor is constrained (a
  bigger lead never lowers the trees' output) only if its logistic weight is
  positive at every minute. Others stay free, e.g. factors whose weight turns
  negative once souls and kills are known, and the style factors (momentum,
  carry concentration, draft scaling).
- **Team flip:** every training row is added with the teams swapped, and
  predictions average both views, so P(team 0) = 1 − P(team 1) exactly.
- **Recalibration:** a symmetric isotonic map fit on 10% of training matches
  the trees never saw.

Tested on 10 days with the newest day held out, and rejected: constraining
every factor (log loss +0.003 overall, +0.013 at minute 45), dropping the
near-duplicates hero levels and enemy time dead (+0.005 at minute 45), more
trees, and 3x more training matches (no gain).

The Model check page shows it against the step 1 per-minute model, with a
paired 95% CI on the log-loss difference per minute. The newest-day-held-out
model is saved to `data/model/win_model.joblib` for the win-probability page.

### Steps 3 to 5: new information, cleaner data, every minute

Results on 10 days (2–11 Nov 2026), newest day held out: 1.84M training and
123k test matches. Log loss, lower is better.

| Minute | Souls only | Before step 3 | Full model | Live model | Accuracy (full) |
|---|---|---|---|---|---|
| 3 | 0.678 | 0.632 | 0.623 | 0.633 | 65.2% |
| 15 | 0.597 | 0.543 | 0.536 | 0.553 | 72.3% |
| 30 | 0.443 | 0.382 | 0.378 | 0.393 | 82.4% |
| 45 | 0.559 | 0.433 | 0.429 | 0.465 | 79.7% |

- **Step 3, new information.** Player history, hero pairs, lane state and
  respawn timers lower log loss at every minute (0.007 at minute 3, 0.003 at
  minute 30; every 95% CI excludes zero). Pre-game factors now carry most of
  the model's early gain. The players' recent win rate adds nothing once the
  rest is known (matchmaking already evens it out); their farming history and
  record on the picked hero do.
- **Step 4, cleaner data.** Patch dates come from the API's patch-notes list
  (`python -m pipeline.patches` → `data/patches.json`) and cut the history
  window; the latest patch (29 Sep) is before this window, so it changes
  nothing yet. Queue flags are model inputs: calibration error is 0.2% overall,
  0.4% in ranked, about 2% in the small new-player and low-priority queues. A
  ranked-only per-minute model beats the shared one on ranked matches (0.5255
  vs 0.5300), so the full model keeps separate weights per queue.
- **Step 5, every minute.** Training on a row per minute instead of only the
  snapshot minutes lowers log loss between snapshots by 0.012 (95% CI 0.011 to
  0.013). The model is told how old the stats are.
- **Live API check.** `https://api.deadlock-api.com/v1/matches/active` exposes
  team souls, objective masks, heroes, account ids, abandons, start time and
  queue while a game runs, but no kills, deaths or per-player stats. So two
  models are saved: `data/model/win_model.joblib` (all factors, for finished
  matches) and `win_model_live.joblib` (live fields only; 72.5% vs 73.6%
  accuracy over all snapshot minutes).

## Win probability

`python -m pipeline.win_probability` builds the per-match graph data in
`data/win_probability.json`; `--match <id> ...` does it for specific matches.

- **Same rows as training.** A match is pulled from the lake by id and run
  through the exact SQL that built the training rows, with a row for every
  minute, then scored by the full model and the live model.
- **Example matches** are picked from the day the saved model was tested on
  (never trained on): the biggest comeback, the most lead changes, a stomp, a
  coin flip, a high-rank ranked match and a typical game.
- **The page** shows one team's win chance per minute with the area tinted by
  the team ahead, objectives and Mid-Boss claims per team on the same timeline,
  kills per minute, a table view, and an optional live-model line.
- **Any match id:** `GET /api/win-probability/{match_id}` looks the match up in
  the lake and scores it on the spot (about 15 seconds). This needs the backend,
  so the GitHub Pages version shows the example matches only.
- The match-metadata API (`/v1/matches/{id}/metadata`) returns the same fields
  as the lake (stat snapshots, death times, objectives, Mid-Boss) without the
  hour's delay; it is the planned source once the site has a hosted backend.

Next: a hosted backend so any match id works online, then a live graph for
games in progress using the live model.
