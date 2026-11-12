// Scores matches in the browser: fetches from the public Deadlock API, builds
// the model's rows (features.ts) and runs the exported models (model.ts).
// Used for live games everywhere, and for match lookups on the static site.
import { apiGet } from "../api";
import { isRanked, isScorable, liveRow, lostObjectives, matchEvents, matchRows, type ActiveMatch, type ApiMatch, type Priors } from "./features";
import { predict, type WebModel } from "./model";

const API = "https://api.deadlock-api.com/v1";
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
  const winner = m.winning_team === 0 || m.winning_team === "Team0" ? 0 : 1;
  return {
    max_minute: 45,
    match: {
      match_id: Number(matchId), label: "", blurb: "", start_time: start.toISOString(), duration_s: m.duration_s,
      queue: isRanked(m) ? "Ranked" : "Unranked", average_badge: null, winner, truncated: m.duration_s > 45 * 60 + 59,
      lowest_winner_chance: null,
      players: m.players.map((p) => ({ team: p.team === 0 ? 0 : 1, hero_id: p.hero_id, kills: p.kills, deaths: p.deaths, net_worth: p.net_worth }))
        .sort((a, b) => b.net_worth - a.net_worth),
      points: matchRows(m, priors).map((x) => ({
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

/** Standard 6v6 games in progress, each with the live model's current win chance for team 0. */
export async function liveGames(): Promise<LiveGame[]> {
  const [all, priors, live] = await Promise.all([deadlock<ActiveMatch[]>("matches/active", "live games"), loadPriors(), loadLiveModel()]);
  const now = Date.now() / 1000;
  return all
    .filter((m) => m.game_mode === 1 && m.players.length === 12 && m.players.filter((p) => p.team === 0).length === 6)
    .map((m) => {
      const row = liveRow(m, priors, now);
      return {
        match_id: m.match_id, minute: (now - m.start_time) / 60, p: predict(live, row), souls: row.souls, total_souls: row.total_souls,
        ranked: row.ranked === 1, spectators: m.spectators ?? 0, region: m.region_mode_parsed ?? "",
        heroes: [0, 1].map((t) => m.players.filter((p) => p.team === t).map((p) => p.hero_id)) as [number[], number[]],
        lost: [lostObjectives(m.objectives_mask_team0 ?? 0xffff).length, lostObjectives(m.objectives_mask_team1 ?? 0xffff).length] as [number, number],
      };
    })
    .sort((a, b) => b.spectators - a.spectators);
}
