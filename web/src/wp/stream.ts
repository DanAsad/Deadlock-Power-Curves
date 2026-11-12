// Reads one "reading" of a match in progress from the Deadlock API's live
// broadcast query (GET /v1/matches/demo/live/query, Server-Sent Events).
// Unlike the featured list, this works for any match that is being played,
// by match id, and carries current per-player stats and objective state.
//
// A query without LIMIT streams every entity 64 times a second (~100 KB/s), so
// every query here asks for exactly the rows of one tick and then ends.
// API limits (per visitor): 20 queries a minute; 6 newly spectated matches an hour.

const QUERY = "https://api.deadlock-api.com/v1/matches/demo/live/query";
const TICKS_PER_S = 64;
const STEAM_ID_BASE = "76561197960265728";          // steam id 64 = this + account id
const D = "m_PlayerDataGlobal__", G = "m_pGameRules__", F = "m_vecFOWEntities__";

export type StreamProblem = "not_ready" | "not_in_game" | "rate_limit" | "network" | "other";
export class StreamError extends Error {
  constructor(message: string, public kind: StreamProblem) { super(message); }
}

function problem(text: string, status?: number): StreamError {
  const t = text.toLowerCase();
  if (t.includes("notingame") || t.includes("not in game") || t.includes("not found") || status === 404)
    return new StreamError("This match is not being played right now (it has ended, or the id is wrong).", "not_in_game");
  if (status === 429 || t.includes("rate") || t.includes("too many"))
    return new StreamError("The Deadlock API's limit was reached (6 new matches an hour per visitor). Try again later.", "rate_limit");
  if (t.includes("not ready") || t.includes("notready") || t.includes("starting") || status === 503 || status === 425)
    return new StreamError("The broadcast for this match is starting up.", "not_ready");
  return new StreamError(`The Deadlock API could not read this match: ${text.slice(0, 160)}`, "other");
}

/** Run one query and return its rows. The query must end by itself (LIMIT). */
async function query<T>(sql: string, matchId: number, timeoutMs = 20000): Promise<T[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const rows: T[] = [];
  try {
    let r: Response;
    try {
      r = await fetch(`${QUERY}?${new URLSearchParams({ query: sql, match_id: String(matchId) })}`,
        { signal: ctl.signal, headers: { Accept: "text/event-stream" } });
    } catch { throw new StreamError("Could not reach the Deadlock API.", "network"); }
    if (!r.ok || !r.body) throw problem(await r.text().catch(() => ""), r.status);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "", ev = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") ev = "";
        else if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (ev === "error") {
            let msg = data, status: number | undefined;
            try { const j = JSON.parse(data); msg = String(j.error ?? data); status = j.status; } catch { /* plain text */ }
            throw problem(msg, status);
          }
          if (ev === "end") { await reader.cancel().catch(() => {}); return rows; }
          if (ev === "status") continue;
          try { rows.push(JSON.parse(data) as T); } catch { /* not a row */ }
        }
      }
    }
    return rows;
  } catch (e) {
    if (e instanceof StreamError) throw e;
    // a timeout with no rows = the broadcast exists but is not sending yet
    throw new StreamError(rows.length ? "The broadcast stopped sending." : "The broadcast for this match is starting up.",
      ctl.signal.aborted ? "not_ready" : "network");
  } finally { clearTimeout(timer); }
}

/** Enums arrive as little-endian hex ("0400000000000000" = 4). */
const enumValue = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && /^[0-9a-f]{4,}$/i.test(v) ? parseInt(v.slice(2, 4) + v.slice(0, 2), 16) : Number(v) || 0;

export interface StreamPlayer {
  team: 0 | 1; hero: number; account: number; souls: number; kills: number; deaths: number; level: number;
  lastHits: number; denies: number; heroDamage: number; objectiveDamage: number;
  alive: boolean; respawnS: number;              // seconds until respawn (0 when alive)
  abandoned: boolean;
}
export interface Reading {
  clockS: number;                                // in-game clock, pauses excluded
  state: "before" | "playing" | "over";
  ranked: boolean; paused: boolean;
  players: StreamPlayer[];
  /** [objective id as in the match data, owner team]; null when the objective list could not be read. */
  destroyed: [number, number][] | null;
  patron: [number, number] | null;               // each team's Patron health, 0..1
}

interface RulesRow { tick: number; gs: number; paused: boolean; pt: number; state: unknown; mode: unknown }
interface PlayerRow {
  tick: number; team: number; hero: number; acc: number | string; nw: number; k: number; d: number; lvl: number; lh: number; dn: number;
  dmg: number; od: number; alive: boolean; resp: number; ab: boolean;
}
interface TeamRow { f_team: number[] | null; f_class: unknown[] | null; f_lane: number[] | null; f_hp: number[] | null }

const RULES_SQL = `SELECT tick, "${G}m_flGameStartTime" AS gs, "${G}m_bGamePaused" AS paused, "${G}m_nTotalPausedTicks" AS pt, ` +
  `"${G}m_eGameState" AS state, "${G}m_eMatchMode" AS mode FROM CCitadelGameRulesProxy LIMIT 1`;
const PLAYERS_SQL = `SELECT tick, "m_iTeamNum" AS team, "${D}m_nHeroID" AS hero, "m_steamID" - ${STEAM_ID_BASE} AS acc, ` +
  `"${D}m_iGoldNetWorth" AS nw, "${D}m_iPlayerKills" AS k, "${D}m_iDeaths" AS d, "${D}m_iLevel" AS lvl, "${D}m_iLastHits" AS lh, ` +
  `"${D}m_iDenies" AS dn, "${D}m_iHeroDamage" AS dmg, "${D}m_iObjectiveDamage" AS od, "${D}m_bAlive" AS alive, ` +
  `"${D}m_flRespawnTime" AS resp, "${D}m_bAbandon" AS ab FROM CCitadelPlayerController LIMIT 16`;
// every team entity carries the same minimap list of both teams' objectives
const TEAM_SQL = `SELECT "${F}m_nTeam" AS f_team, "${F}m_eClass" AS f_class, "${F}m_iLane" AS f_lane, "${F}m_nHealthPercent" AS f_hp ` +
  `FROM CCitadelTeam WHERE "m_iTeamNum" = 2 LIMIT 1`;

// minimap classes, and the stream's lane numbers -> the lane slots used by the match data's objective ids
const CLASS = { guardian: 0x05, shrine: 0x1c, walker: 0x1d, baseGuardian: 0x1e, patron: 0x1f };
const LANE_SLOT: Record<number, number> = { 1: 1, 4: 3, 6: 4 };

/** Destroyed objectives per team from the minimap list. Exported for tests. */
export function objectivesFromMinimap(t: TeamRow): { destroyed: [number, number][]; patron: [number, number] } | null {
  if (!t.f_team || !t.f_class || !t.f_lane || !t.f_hp) return null;
  const destroyed: [number, number][] = [], patron: [number, number] = [0, 0];
  for (const owner of [0, 1] as const) {
    const mine = t.f_team.map((team, i) => ({ team, cls: enumValue(t.f_class![i]), lane: t.f_lane![i], hp: t.f_hp![i] }))
      .filter((e) => e.team === owner + 2);
    const pat = mine.find((e) => e.cls === CLASS.patron);
    if (!pat) return null;                        // list not filled in yet: say "unknown", never "everything destroyed"
    patron[owner] = pat.hp / 255;
    const alive = (cls: number, lane?: number) => mine.filter((e) => e.cls === cls && e.hp > 0 && (lane == null || e.lane === lane)).length;
    for (const [lane, slot] of Object.entries(LANE_SLOT)) {
      if (!alive(CLASS.guardian, +lane)) destroyed.push([slot, owner]);
      if (!alive(CLASS.walker, +lane)) destroyed.push([4 + slot, owner]);
      if (!alive(CLASS.baseGuardian, +lane)) destroyed.push([11 + slot, owner]);     // both of the lane's pair are down
    }
    const shrinesDown = Math.max(0, 2 - alive(CLASS.shrine));
    for (let i = 0; i < shrinesDown; i++) destroyed.push([10 + i, owner]);
  }
  return { destroyed, patron };
}

/** One reading of the match. `first` = nothing read yet: open the broadcast with a single query, so
 *  three parallel queries cannot each count as a newly spectated match. */
export async function readMatch(matchId: number, first: boolean): Promise<Reading> {
  let rules: RulesRow[];
  let players: PlayerRow[], teams: TeamRow[];
  if (first) {
    rules = await query<RulesRow>(RULES_SQL, matchId, 45000);      // a broadcast nobody has watched yet takes 10-30 s to start
    [players, teams] = await Promise.all([query<PlayerRow>(PLAYERS_SQL, matchId), query<TeamRow>(TEAM_SQL, matchId).catch(() => [])]);
  } else {
    [rules, players, teams] = await Promise.all([query<RulesRow>(RULES_SQL, matchId), query<PlayerRow>(PLAYERS_SQL, matchId),
      query<TeamRow>(TEAM_SQL, matchId).catch(() => [])]);
  }
  const g = rules[0];
  if (!g || !players.length) throw new StreamError("The broadcast for this match is starting up.", "not_ready");
  const tick = players[0].tick;
  const now = (tick - (g.pt ?? 0)) / TICKS_PER_S;            // server time, pauses excluded
  const seen = new Set<number>();
  const list: StreamPlayer[] = [];
  for (const p of players) {
    if ((p.team !== 2 && p.team !== 3) || !p.hero || seen.has(p.hero * 10 + p.team)) continue;   // spectators, repeats of a later tick
    seen.add(p.hero * 10 + p.team);
    list.push({
      team: p.team === 2 ? 0 : 1, hero: p.hero, account: Number(p.acc) || 0, souls: p.nw ?? 0, kills: p.k ?? 0, deaths: p.d ?? 0,
      level: p.lvl ?? 0, lastHits: p.lh ?? 0, denies: p.dn ?? 0, heroDamage: p.dmg ?? 0, objectiveDamage: p.od ?? 0,
      alive: !!p.alive, respawnS: p.alive ? 0 : Math.max(0, (p.resp ?? 0) - now), abandoned: !!p.ab,
    });
  }
  const state = enumValue(g.state);
  const obj = teams[0] ? objectivesFromMinimap(teams[0]) : null;
  return {
    clockS: Math.max(0, now - (g.gs ?? 0)), state: state < 7 ? "before" : state === 7 ? "playing" : "over",
    ranked: enumValue(g.mode) === 4, paused: !!g.paused, players: list,
    destroyed: obj?.destroyed ?? null, patron: obj?.patron ?? null,
  };
}
