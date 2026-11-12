// Player-history factors in the browser, from each player's public match
// history (GET /v1/players/{account_id}/match-history). Mirrors
// player_features() in pipeline/win_factors.py: the 30 days before the match
// day (never the day itself), shrunk toward the average with the same priors.
// A player whose history cannot be loaded counts as average.
import type { Priors } from "./features";
import type { Row } from "./model";

const API = "https://api.deadlock-api.com/v1";
const DAY_S = 86400;

interface HistoryMatch {
  match_id: number; hero_id: number; start_time: number; game_mode: number; match_mode: number;
  player_team: number; net_worth: number; match_duration_s: number; match_result: number;
}
export interface HistoryPlayer { team: number; hero: number; account: number }

const cache = new Map<number, Promise<HistoryMatch[] | null>>();
function matchHistory(account: number): Promise<HistoryMatch[] | null> {
  if (!cache.has(account)) {
    cache.set(account, fetch(`${API}/players/${account}/match-history?only_stored_history=true`)
      .then((r) => (r.ok ? (r.json() as Promise<HistoryMatch[]>) : null)).catch(() => null));
  }
  return cache.get(account)!;
}

/** First second of the look-back window for a match on the UTC day starting at `dayS` (pipeline/patches.py). */
export function windowStart(dayS: number, pl: NonNullable<Priors["player"]>): number {
  const start = dayS - pl.history_days * DAY_S;
  const patch = pl.patches.map((d) => Date.parse(`${d}T00:00:00Z`) / 1000).filter((p) => p <= dayS - DAY_S).pop();
  return patch != null && patch > start && (dayS - patch) / DAY_S >= pl.min_days_on_patch ? patch : start;
}

/** One player's factor values from their history before `dayS`. Exported for tests. */
export function playerValues(history: HistoryMatch[] | null, hero: number, dayS: number, pl: NonNullable<Priors["player"]>) {
  const from = windowStart(dayS, pl);
  let N = 0, W = 0, SPM = 0, n = 0, wins = 0;
  const seen = new Set<number>();
  for (const m of history ?? []) {
    if (m.start_time < from || m.start_time >= dayS || m.game_mode !== 1 || (m.match_mode !== 1 && m.match_mode !== 4)) continue;
    if (m.match_duration_s < pl.min_duration_s || seen.has(m.match_id)) continue;
    seen.add(m.match_id);
    const won = m.match_result === m.player_team ? 1 : 0;
    N += 1; W += won; SPM += (m.net_worth * 60) / m.match_duration_s;
    if (m.hero_id === hero) { n += 1; wins += won; }
  }
  return {
    hero_experience: Math.min(n, pl.experience_cap),
    player_form: ((W + pl.form_prior / 2) / (N + pl.form_prior) - 0.5) * 100,
    player_farm: (SPM + pl.farm_prior * pl.avg_spm) / (N + pl.farm_prior),
    hero_mastery: ((wins + pl.mastery_prior / 2) / (n + pl.mastery_prior) - 0.5) * 100,
  };
}

export interface HistoryResult { row: Row; loaded: number; players: number }

/** The four player-history factors (team 0's average minus team 1's) for a match starting at `startS`. */
export async function playerHistory(players: HistoryPlayer[], startS: number, priors: Priors): Promise<HistoryResult> {
  const pl = priors.player;
  const zero = { hero_experience: 0, player_form: 0, player_farm: 0, hero_mastery: 0 };
  if (!pl || !players.length) return { row: zero, loaded: 0, players: players.length };
  const dayS = Math.floor(startS / DAY_S) * DAY_S;
  const out: (ReturnType<typeof playerValues> & { team: number })[] = [];
  let loaded = 0, next = 0;
  const worker = async () => {                     // a few at a time: each history is a few hundred KB
    while (next < players.length) {
      const p = players[next++];
      const h = p.account > 0 ? await matchHistory(p.account) : null;
      if (h) loaded += 1;
      out.push({ ...playerValues(h, p.hero, dayS, pl), team: p.team });
    }
  };
  await Promise.all([0, 1, 2, 3].map(worker));
  const row: Row = {};
  for (const key of Object.keys(zero) as (keyof typeof zero)[]) {
    const avg = (t: number) => { const v = out.filter((x) => x.team === t); return v.length ? v.reduce((s, x) => s + x[key], 0) / v.length : 0; };
    row[key] = avg(0) - avg(1);
  }
  return { row, loaded, players: players.length };
}
