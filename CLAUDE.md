# Project brief: Deadlock analytics web app

Owner: Dan. Portfolio project for data analyst / data scientist roles, inspired by
TheWonderCow's statistics videos on Dota 2.

## Goal
A web app with a clean, simple frontend in the style of deadlock-api.com where
users browse and filter charts about Deadlock heroes.
- **Phase 1 (now):** hero power curves: win rate by game length per hero, with
  95% confidence intervals and a scaling index (early-game vs late-game).
- **Phase 2 (later):** win-probability model with a per-match win-probability
  graph for spectators (public and pro matches), annotated with kills and objectives.
  Design Phase 1 so this slots in as another section, not a rewrite.

## Data
- Source: Deadlock API public data lake (free, read-only, updated hourly), read
  with DuckDB. Connection is in `pipeline/lake.py` (catalog moved to
  data.deadlock-api.com in 2026; needs OVERRIDE_DATA_PATH). If it breaks, copy
  the current snippet from https://deadlock-api.com/data-dumps.
- Schema verified in `schema.md` (regenerate: `python -m pipeline.explore_schema`).
  Everything is in `dl.main.match_player` (denormalised, no match_info table).
- Per-player time series exist (`stats.time_stamp_s`, `stats.net_worth`, ...):
  use them for at-minute power curves and Phase 2 training data.
- Deduplicate player rows per (match_id, hero_id): the lake can hold unmerged duplicates.
- Hero names/images: https://api.deadlock-api.com/v1/assets/heroes (send a User-Agent).

## Architecture
- `pipeline/`: Python jobs that query the lake and write small precomputed
  Parquet/JSON tables (power curves per hero x length bucket x rank x patch).
  The web app reads these, never the full lake on each page load.
- `api/`: FastAPI serving the precomputed tables with filter params
  (patch, rank bracket, game mode, date range).
- `web/`: React + Vite + TypeScript frontend. Pages: hero grid → hero detail
  (power curve), all-heroes power curve small multiples, scaling index ranking.
  Filters in one row above the charts. Hover tooltips on every chart.
- Analysis code lives in `pipeline/` (stats.py, extract.py, build.py); the demo
  recovery check is `pipeline/tests/test_stats.py`.
- "What wins games" tab: `pipeline/win_factors.py` (+ win_factors_sql.py) →
  data/win_factors.json → api/routers/win_factors.py → web/src/pages/WinFactors.tsx.
  Its per-snapshot team-difference rows are the starting point for Phase 2.
- "Model check" tab: `pipeline/evaluate.py` → data/model_eval.json →
  api/routers/model_eval.py → web/src/pages/ModelCheck.tsx. Baseline for every
  model change: newest-day-held-out log loss, Brier, ECE per minute.
- Win model: `pipeline/model.py` (one boosted model over all minutes, linear
  score per queue as an input, team-flip symmetric, isotonic recalibration).
  evaluate.py trains it and saves data/model/win_model.joblib (all factors) and
  win_model_live.joblib (only fields the live-matches API has).
- "Win probability" tab: `pipeline/win_probability.py` → data/win_probability.json
  (example matches) → api/routers/win_probability.py (also scores any match id
  from the lake on demand) → web/src/pages/WinProbability.tsx + charts/WinProb.tsx.
- Online: GitHub Pages at https://danasad.github.io/Deadlock-Power-Curves/, static
  mode (api/export_static.py + VITE_STATIC=1), redeployed by .github/workflows/pages.yml.
- Training rows: snapshot minutes for all matches, every minute for match_id % 5 == 2.
  Between snapshots stats are carried forward, never interpolated (that leaks).
- Patch dates: `pipeline/patches.py` → data/patches.json (read by config.PATCHES).
- History caches per day: data/cache/ph_* (player-hero games, wins, souls/min)
  and hp_* (hero pairs); wf_* files carry a `wf_version` and refetch when it changes.

## Stats rules
- Always show sample size and 95% CIs; hide buckets under the minimum-games threshold.
- Note in the UI: game length is an outcome, not a clock (stomps end early).
- For Phase 2: split train/test by match, never by row; report Brier score,
  log loss and a calibration curve.

## Working style
Dan prefers direct, continuation-oriented work: make edits without asking
before each one; explain decisions briefly.
After each finished change, commit and push to GitHub (origin/main) without
being asked. Never commit `data/cache/`.
