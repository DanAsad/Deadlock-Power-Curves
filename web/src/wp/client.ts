// Scores matches in the browser: fetches from the public Deadlock API, builds
// the model's rows (features.ts) and runs the exported models (model.ts).
// Used for live games everywhere, and for match lookups on the static site.
import { apiGet } from "../api";
import { isRanked, isScorable, liveRow, lostObjectives, matchEvents, matchRows, type ActiveMatch, type ApiMatch, type Priors } from "./features";
import { playerHistory } from "./history";
import { predict, type WebModel } from "./model";

const API = "https://api.deadlock-api.com/v1";
const STALE_MIN = 30;        // newest listed game older than this = a stale copy of the list
// The list's start_time is when the match was created; the in-game clock starts about 2 minutes later
// (hero select and loading). Measured against the live broadcast clock on 2026-11-12: 2.0 to 2.5 minutes.
const CLOCK_OFFSET_S = 120;
const cache = new Map<string, Promise<unknown>>();
const once = <T,>(name: string): Promise<T> => {
  if (!cache.has(name)) {
    const p = apiGet<T>(`web-model/${name}`);
    p.catch(() => cache.delete(name));              // let a failed download be retried
    cache.set(name, p);
  }
  return cache.get(name) as Promise<T>;
};
export const loadPriors = () => once<Priors & { model_held_out_day?: string }>("priors");
export const loadFullModel = () => once<WebModel>("win_model");
export const loadLiveModel = () => once<WebModel>("win_model_live");
export const loadStreamModel = () => once<WebModel>("win_model_stream");

async function deadlock<T>(path: string, what: string): Promise<T> {
  let r: Response;
  try { r = await fetch(`${API}/${path}`); } catch { throw new Error(`Could not reach the Deadlock API for ${what}`); }
  if (r.status === 404) throw new Error(`${what} was not found by the Deadlock API`);
  if (r.status === 429) throw new Error("The Deadlock API is rate-limiting requests; try again in a minute");
  if (!r.ok) throw new Error(`The Deadlock API returned an error for ${what} (HTTP ${r.status})`);
  return r.json();
}

/** A finished match, in the same shape the backend's /win-probability/{id} returns. */
export async function scoreMatch(matchId: string) {
  const [raw, priors, full, live] = await Promise.all([
    deadlock<{ match_info?: ApiMatch } & ApiMatch>(`matches/${matchId}/metadata`, `match ${matchId}`),
    loadPriors(), loadFullModel(), loadLiveModel(),
  ]);
  const m = raw.match_info ?? raw;
  const why = isScorable(m);
  if (why) throw new Error(`Match ${matchId} can't be scored: ${why}`);
  const start = typeof m.start_time === "number" ? new Date(m.start_time * 1000) : new Date(m.start_time);
  // player history from the public match histories; if that fails, players count as average
  const history = await playerHistory(m.players.map((p) => ({ team: p.team === 0 ? 0 : 1, hero: p.hero_id, account: p.account_id })),
    start.getTime() / 1000, priors).catch(() => ({ row: {}, loaded: 0, players: m.players.length }));
  const winner = m.winning_team === 0 || m.winning_team === "Team0" ? 0 : 1;
  return {
    max_minute: 45,
    match: {
      match_id: Number(matchId), label: "", blurb: "", start_time: start.toISOString(), duration_s: m.duration_s,
      queue: isRanked(m) ? "Ranked" : "Unranked", average_badge: null, winner, truncated: m.duration_s > 45 * 60 + 59,
      lowest_winner_chance: null, history_players: history.loaded,
      players: m.players.map((p) => ({ team: p.team === 0 ? 0 : 1, hero_id: p.hero_id, kills: p.kills, deaths: p.deaths, net_worth: p.net_worth }))
        .sort((a, b) => b.net_worth - a.net_worth),
      points: matchRows(m, priors, history.row).map((x) => ({
        minute: x.minute, p: predict(full, x.row), p_live: predict(live, x.row), souls: x.souls, kills0: x.kills0, kills1: x.kills1,
      })),
      events: matchEvents(m),
    },
  };
}

export interface LiveGame {
  match_id: number; minute: number; p: number; souls: number; total_souls: number; ranked: boolean;
  spectators: number; region: string; heroes: [number[], number[]]; lost: [number, number];
}

/** The game mode of a match from the live list, if it is listed (null = not listed or the list is unreachable).
 *  Checked before opening a broadcast, so a Street Brawl game does not use up one of the 6 tracked matches an hour. */
export async function listedMode(matchId: number): Promise<string | null> {
  try {
    const all = await deadlock<ActiveMatch[]>("matches/active", "live games");
    const m = all.find((x) => x.match_id === matchId);
    if (!m) return null;
    return m.game_mode === 1 ? "normal" : m.game_mode === 4 ? "street_brawl" : (m.game_mode_parsed ?? `mode ${m.game_mode}`);
  } catch { return null; }
}

/** Standard 6v6 games in progress, each with the live model's current win chance for team 0. */
export async function liveGames(): Promise<LiveGame[]> {
  const [priors, live] = await Promise.all([loadPriors(), loadLiveModel()]);
  // A new address every 20 seconds, so the API's cache cannot hand out a copy that is minutes old.
  // If the API itself is struggling, that uncached request fails; then the cached copy is better than nothing.
  let all: ActiveMatch[];
  try { all = await deadlock<ActiveMatch[]>(`matches/active?fresh=${Math.floor(Date.now() / 20000)}`, "live games"); }
  catch { all = await deadlock<ActiveMatch[]>("matches/active", "live games"); }
  const now = Date.now() / 1000;
  // A real list always has games that started recently; if even the newest one is old, the copy is out of date.
  const newest = Math.min(...all.map((m) => (now - m.start_time) / 60), Infinity);
  if (all.length && newest > STALE_MIN) throw new Error("The Deadlock API is returning an out-of-date list of live games; try again in a few minutes");
  return all
    .filter((m) => m.game_mode === 1 && m.players.length === 12 && m.players.filter((p) => p.team === 0).length === 6)
    .map((m) => {
      const row = liveRow(m, priors, now - CLOCK_OFFSET_S);
      return {
        match_id: m.match_id, minute: row.minute, p: predict(live, row), souls: row.souls, total_souls: row.total_souls,
        ranked: row.ranked === 1, spectators: m.spectators ?? 0, region: m.region_mode_parsed ?? "",
        heroes: [0, 1].map((t) => m.players.filter((p) => p.team === t).map((p) => p.hero_id)) as [number[], number[]],
        lost: [lostObjectives(m.objectives_mask_team0 ?? 0xffff).length, lostObjectives(m.objectives_mask_team1 ?? 0xffff).length] as [number, number],
      };
    })
    .sort((a, b) => b.spectators - a.spectators);
}
