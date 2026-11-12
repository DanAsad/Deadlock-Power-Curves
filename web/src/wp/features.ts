// Builds the model's per-minute rows from Deadlock API responses, in the
// browser. This re-implements pipeline/win_factors_sql.py; `npm run test:parity`
// checks both give the same win chances on the fixture matches.
//
// Not available here: player history and ranks (those factors stay 0 = average).
import type { Row } from "./model";

// --- match metadata (https://api.deadlock-api.com/v1/matches/{id}/metadata) ---
export interface ApiStat {
  time_stamp_s: number; net_worth: number; kills: number; level: number; creep_kills: number; neutral_kills: number;
  denies: number; player_damage: number; boss_damage: number; gold_death_loss: number;
}
export interface ApiPlayer {
  account_id: number; player_slot: number; team: number; hero_id: number; kills: number; deaths: number;
  net_worth: number; abandon_match_time_s: number | null; stats: ApiStat[];
  death_details: { game_time_s: number; death_duration_s: number }[];
}
export interface ApiMatch {
  match_id: number; start_time: number | string; duration_s: number; match_outcome: number | string;
  winning_team: number | string; game_mode: number | string; match_mode: number | string;
  is_high_skill_range_parties: boolean | null; low_pri_pool: boolean | null; new_player_pool: boolean | null;
  not_scored: boolean | null;
  objectives: { team_objective_id: number; team: number; destroyed_time_s: number }[];
  mid_boss: { team_claimed: number; destroyed_time_s: number }[] | null;
  players: ApiPlayer[];
}

export interface Priors {
  as_of: string;
  heroes: Record<string, { scaling: number; win_rate: number }>;
  synergy: [number, number, number][];      // [hero a, hero b, effect], a < b, same team
  counter: [number, number, number][];      // [hero a, hero b, effect of a against b], a < b
}

export const MAX_MINUTE = 45;
const SNAPSHOT_S = [180, 360, 540, 720, 900, 1200, 1500, 1800, 2100, 2400, 2700];
// objective ids = bit positions in the live objectives mask
const KIND: Record<number, "guardians" | "walkers" | "base_guardians" | "shrines"> = {
  1: "guardians", 2: "guardians", 3: "guardians", 4: "guardians",
  5: "walkers", 6: "walkers", 7: "walkers", 8: "walkers",
  10: "shrines", 11: "shrines",
  12: "base_guardians", 13: "base_guardians", 14: "base_guardians", 15: "base_guardians",
};
const LANE = (id: number) => (id <= 4 ? id : id <= 8 ? id - 4 : id - 11);     // only for lane objectives
const OBJECTIVE_LABEL: Record<number, [string, string]> = {
  0: ["patron", "Patron destroyed"], 9: ["patron", "Patron weakened"],
  1: ["guardian", "Guardian"], 2: ["guardian", "Guardian"], 3: ["guardian", "Guardian"], 4: ["guardian", "Guardian"],
  5: ["walker", "Walker"], 6: ["walker", "Walker"], 7: ["walker", "Walker"], 8: ["walker", "Walker"],
  10: ["shrine", "Shrine"], 11: ["shrine", "Shrine"],
  12: ["base_guardian", "Base Guardian"], 13: ["base_guardian", "Base Guardian"],
  14: ["base_guardian", "Base Guardian"], 15: ["base_guardian", "Base Guardian"],
};
const teamOf = (t: number | string) => (t === 0 || t === "Team0" || t === "0" ? 0 : 1);
const sgn = (team: number) => (team === 0 ? 1 : -1);            // +1 for team 0

// --- draft ---------------------------------------------------------------------
function pairMaps(p: Priors) {
  const S = new Map<string, number>(), C = new Map<string, number>();
  for (const [a, b, v] of p.synergy) { S.set(`${a},${b}`, v); S.set(`${b},${a}`, v); }
  for (const [a, b, v] of p.counter) { C.set(`${a},${b}`, v); C.set(`${b},${a}`, -v); }
  return { S, C };
}

/** Pre-game draft factors (team 0 minus team 1), in the units the model was trained on. */
export function draftFeatures(h0: number[], h1: number[], p: Priors): Row {
  const { S, C } = pairMaps(p);
  const scale = (hs: number[]) => hs.reduce((s, h) => s + (p.heroes[h]?.scaling ?? 0), 0);
  const strength = (hs: number[]) => hs.reduce((s, h) => s + ((p.heroes[h]?.win_rate ?? 0.5) - 0.5) * 100, 0);
  const syn = (hs: number[]) => {
    let s = 0;
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) s += S.get(`${hs[i]},${hs[j]}`) ?? 0;
    return s;
  };
  let counter = 0;
  for (const a of h0) for (const b of h1) counter += C.get(`${a},${b}`) ?? 0;
  return {
    draft_scaling: scale(h0) - scale(h1), draft_strength: strength(h0) - strength(h1),
    draft_synergy: (syn(h0) - syn(h1)) * 100, draft_counter: counter * 100,
  };
}

// --- objectives ----------------------------------------------------------------
/** Objective factors from the list of destroyed objectives: [objective id, owner team]. */
export function objectiveFeatures(destroyed: [number, number][]): Row {
  const out: Row = { guardians: 0, walkers: 0, base_guardians: 0, shrines: 0, open_lanes: 0, deepest_push: 0 };
  const depth = new Map<string, { depth: number; outer: number; s: number }>();
  for (const [id, owner] of destroyed) {
    const kind = KIND[id];
    if (!kind) continue;
    const s = owner === 1 ? 1 : -1;                  // counts for the team that does NOT own it
    out[kind] += s;
    if (kind === "shrines") continue;
    const key = `${s},${LANE(id)}`;
    const d = depth.get(key) ?? { depth: 0, outer: 0, s };
    d.depth += 1;
    if (kind !== "base_guardians") d.outer += 1;
    depth.set(key, d);
  }
  let deep0 = 0, deep1 = 0;
  for (const d of depth.values()) {
    if (d.outer >= 2) out.open_lanes += d.s;
    if (d.s === 1) deep0 = Math.max(deep0, d.depth); else deep1 = Math.max(deep1, d.depth);
  }
  out.deepest_push = deep0 - deep1;
  return out;
}

// --- finished matches ------------------------------------------------------------
export interface BuiltPoint { minute: number; row: Row; souls: number; kills0: number; kills1: number }
export interface BuiltEvent { t: number; kind: string; label: string; by: number }

export function isScorable(m: ApiMatch): string | null {
  if (!(m.game_mode === 1 || m.game_mode === "Normal")) return "not a standard 6v6 match";
  if (!(m.match_outcome === 0 || m.match_outcome === "TeamWin")) return "the match has no winner";
  if (m.players.length !== 12 || m.players.filter((p) => teamOf(p.team) === 0).length !== 6) return "the match does not have 6 players per team";
  if (m.duration_s < 480) return "the match is shorter than 8 minutes";
  return null;
}

export function isRanked(m: { match_mode: number | string }): boolean {
  return m.match_mode === 4 || m.match_mode === "Ranked";
}

/** One row per full game minute before the match ended (up to minute 45). */
export function matchRows(m: ApiMatch, priors: Priors): BuiltPoint[] {
  const dur = m.duration_s;
  const players = m.players.map((p) => ({
    team: teamOf(p.team),
    snaps: p.stats.filter((s) => s.time_stamp_s < dur).sort((a, b) => a.time_stamp_s - b.time_stamp_s),   // never the game-end snapshot
    deaths: p.death_details,
    abandon: p.abandon_match_time_s ?? 0,
  }));
  const h = (t: number) => m.players.filter((p) => teamOf(p.team) === t).map((p) => p.hero_id);
  const draft = draftFeatures(h(0), h(1), priors);
  const context = {
    ranked: isRanked(m) ? 1 : 0, low_pri: m.low_pri_pool ? 1 : 0, new_player: m.new_player_pool ? 1 : 0,
    wide_party: m.is_high_skill_range_parties ? 1 : 0,
  };

  // team totals at time t: each player's latest snapshot at or before t, carried forward
  const totals = (t: number) => {
    const z = () => ({ nw: 0, kills: 0, lvl: 0, lh: 0, dn: 0, dmg: 0, bd: 0, gdl: 0, top: 0 });
    const T = [z(), z()];
    for (const p of players) {
      let s: ApiStat | null = null;
      for (const x of p.snaps) if (x.time_stamp_s <= t) s = x; else break;
      if (!s) continue;
      const a = T[p.team];
      a.nw += s.net_worth; a.kills += s.kills; a.lvl += s.level; a.lh += s.creep_kills + s.neutral_kills;
      a.dn += s.denies; a.dmg += s.player_damage; a.bd += s.boss_damage; a.gdl += s.gold_death_loss;
      a.top = Math.max(a.top, s.net_worth);
    }
    return T;
  };
  const soulsAt = (t: number) => { const T = totals(t); return T[0].nw - T[1].nw; };
  // soul-lead change between the two latest snapshots, per 5 minutes
  const snaps = SNAPSHOT_S.filter((s) => s < dur);
  const momentum = snaps.map((s, i) => (i === 0 ? 0 : ((soulsAt(s) - soulsAt(snaps[i - 1])) * 300) / (s - snaps[i - 1])));

  const out: BuiltPoint[] = [];
  for (let t = 60; t <= MAX_MINUTE * 60 && t < dur; t += 60) {
    const [a, b] = totals(t);
    const share = (x: { nw: number; top: number }) => (x.nw > 0 ? x.top / x.nw : 1 / 6);
    let mom = 0;
    snaps.forEach((s, i) => { if (s <= t) mom = momentum[i]; });

    let deadNow = 0, respawn = 0, deadTime = 0, abandons = 0, kills0 = 0, kills1 = 0;
    for (const p of players) {
      const s = sgn(p.team);
      if (p.abandon > 0 && p.abandon <= t) abandons += s;
      for (const d of p.deaths) {
        const at = d.game_time_s, len = d.death_duration_s;
        if (Math.ceil(at / 60) === t / 60) { if (p.team === 1) kills0 += 1; else kills1 += 1; }   // shown at that minute
        if (at > t) continue;
        if (t < at + len) { deadNow += s; respawn += s * (at + len - t); }
        deadTime += s * Math.min(len, t - at);
      }
    }
    const mid = (m.mid_boss ?? []).reduce((v, x) => v + (x.destroyed_time_s > 0 && x.destroyed_time_s <= t ? sgn(teamOf(x.team_claimed)) : 0), 0);
    const obj = objectiveFeatures(m.objectives.filter((o) => o.destroyed_time_s > 0 && o.destroyed_time_s <= t)
      .map((o) => [o.team_objective_id, teamOf(o.team)]));

    const row: Row = {
      minute: t / 60, total_souls: a.nw + b.nw, ...context, ...draft, ...obj,
      souls: a.nw - b.nw, kills: a.kills - b.kills, levels: a.lvl - b.lvl, last_hits: a.lh - b.lh,
      denies: a.dn - b.dn, hero_damage: a.dmg - b.dmg, objective_damage: a.bd - b.bd,
      enemy_souls_lost: b.gdl - a.gdl, carry_concentration: 100 * (share(a) - share(b)), momentum: mom,
      mid_boss: mid, enemies_dead: -deadNow, enemy_dead_time: -deadTime, enemy_respawn: -respawn,
      enemy_abandons: -abandons,
    };
    out.push({ minute: t / 60, row, souls: a.nw - b.nw, kills0, kills1 });
  }
  return out;
}

export function matchEvents(m: ApiMatch): BuiltEvent[] {
  const ev: BuiltEvent[] = [];
  for (const o of m.objectives) {
    if (!(o.destroyed_time_s > 0)) continue;
    const [kind, label] = OBJECTIVE_LABEL[o.team_objective_id] ?? ["objective", "Objective"];
    ev.push({ t: o.destroyed_time_s, kind, label, by: 1 - teamOf(o.team) });
  }
  for (const b of m.mid_boss ?? []) if (b.destroyed_time_s > 0) ev.push({ t: b.destroyed_time_s, kind: "mid_boss", label: "Mid-Boss claimed", by: teamOf(b.team_claimed) });
  return ev.sort((x, y) => x.t - y.t);
}

// --- live games (https://api.deadlock-api.com/v1/matches/active) -----------------
export interface ActiveMatch {
  match_id: number; start_time: number; spectators: number | null;
  net_worth_team_0: number | null; net_worth_team_1: number | null;
  objectives_mask_team0: number | null; objectives_mask_team1: number | null;
  match_mode: number; match_mode_parsed?: string; game_mode: number; game_mode_parsed?: string;
  low_pri_pool?: boolean | null; region_mode_parsed?: string;
  players: { account_id: number; team: number; hero_id: number; abandoned: boolean | null }[];
}

/** Objectives a team has lost, from its mask (a set bit = still standing). */
export function lostObjectives(mask: number): number[] {
  return Object.keys(KIND).map(Number).filter((id) => ((mask >> id) & 1) === 0 && id !== 2 && id !== 6 && id !== 13);   // lane 2 does not exist
}

/** The live model's row for a game in progress. Stats are current, so stale = 0. */
export function liveRow(m: ActiveMatch, priors: Priors, nowS: number): Row {
  const h = (t: number) => m.players.filter((p) => p.team === t).map((p) => p.hero_id);
  const destroyed: [number, number][] = [
    ...lostObjectives(m.objectives_mask_team0 ?? 0xffff).map((id) => [id, 0] as [number, number]),
    ...lostObjectives(m.objectives_mask_team1 ?? 0xffff).map((id) => [id, 1] as [number, number]),
  ];
  const n0 = m.net_worth_team_0 ?? 0, n1 = m.net_worth_team_1 ?? 0;
  const left = m.players.reduce((v, p) => v + (p.abandoned ? sgn(p.team) : 0), 0);
  return {
    minute: Math.min(Math.max((nowS - m.start_time) / 60, 0), MAX_MINUTE), total_souls: n0 + n1, stale: 0,
    ranked: m.match_mode === 4 || m.match_mode_parsed === "Ranked" ? 1 : 0, low_pri: m.low_pri_pool ? 1 : 0,
    souls: n0 - n1, enemy_abandons: -left,
    ...objectiveFeatures(destroyed), ...draftFeatures(h(0), h(1), priors),
  };
}
