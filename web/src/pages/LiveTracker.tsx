// Follows one match in progress through the live broadcast stream: a reading
// every 30 seconds, scored in the browser with the stream model.
//
// The broadcast only carries the current state, so minutes before tracking
// started cannot be recovered while the match runs. What the panel does instead:
//  * a starting point at minute 0: the pre-game win chance (draft and players),
//    joined to the first reading by a dashed "not recorded" line
//  * keeps the readings in this browser, so a reload or a closed tab continues the graph
//  * after the match ends, checks for the full match data, which has every minute
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Hero } from "../api";
import { LiveLine, type LiveEvent, type LivePoint } from "../charts/LiveLine";
import { EVENT_LETTER, TEAM_COLOR } from "../charts/WinProb";
import { listedMode, loadPriors, loadStreamModel } from "../wp/client";
import { draftFeatures, isScorable, newObjectiveEvents, streamRow, type ApiMatch, type PastLead, type Priors } from "../wp/features";
import { playerHistory } from "../wp/history";
import { predict, type Row, type WebModel } from "../wp/model";
import { readMatch, StreamError, type Reading } from "../wp/stream";

const POLL_S = 30;
const KEEP_H = 6;                                              // saved readings older than this are dropped
const FULL_CHECKS = 30;                                        // after the end: look for the full data this many minutes
const pc = (v: number) => `${Math.round(v * 100)}%`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const EVENT_NAMES: [string, string][] = [["guardian", "Guardian"], ["walker", "Walker"], ["base_guardian", "Base Guardian"], ["shrine", "Shrine"]];

interface Step { reading: Reading; row: Row }                   // row = everything except player history
type Status = { kind: "loading" | "live" | "waiting" | "over" | "error"; text: string };
interface Saved { saved: number; steps: Step[]; events: LiveEvent[]; past: PastLead[]; known: [number, number][] | null }

// --- readings kept in this browser (per match) ---------------------------------
/** Why a match cannot be scored: the model only knows standard 6v6 games. */
const notScorable = (mode: string) => mode === "street_brawl"
  ? "This is a Street Brawl game (4v4). The win model was trained on standard 6v6 matches only, so it can't score it."
  : `This is not a standard 6v6 match (${mode}), so the model can't score it.`;
const key = (id: number) => `dpc-track-${id}`;
function loadSaved(id: number): Saved | null {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {         // forget old matches
      const k = localStorage.key(i);
      if (!k?.startsWith("dpc-track-")) continue;
      const s = JSON.parse(localStorage.getItem(k) ?? "null") as Saved | null;
      if (!s || now - s.saved > KEEP_H * 3600e3) localStorage.removeItem(k);
    }
    return JSON.parse(localStorage.getItem(key(id)) ?? "null") as Saved | null;
  } catch { return null; }
}
function save(id: number, s: Omit<Saved, "saved">) {
  try { localStorage.setItem(key(id), JSON.stringify({ saved: Date.now(), ...s })); } catch { /* full or blocked: the graph still works */ }
}
function forget(id: number) { try { localStorage.removeItem(key(id)); } catch { /* blocked */ } }

export function LiveTracker({ matchId, teams, heroes, onClose }:
  { matchId: number; teams: [string, string]; heroes: Map<number, Hero>; onClose: () => void }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [history, setHistory] = useState<{ row: Row; loaded: number; players: number } | null>(null);
  const [model, setModel] = useState<WebModel | null>(null);
  const [priors, setPriors] = useState<Priors | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading", text: "Opening the broadcast…" });
  const [restored, setRestored] = useState(0);
  const [full, setFull] = useState<"checking" | "ready" | "gave_up">("checking");
  const mem = useRef<{ past: PastLead[]; known: [number, number][] | null; steps: Step[]; events: LiveEvent[] }>(
    { past: [], known: null, steps: [], events: [] });

  useEffect(() => {
    let stop = false, timer = 0, misses = 0, opened = false, askedHistory = false;
    const saved = loadSaved(matchId);
    mem.current = { past: saved?.past ?? [], known: saved?.known ?? null, steps: saved?.steps ?? [], events: saved?.events ?? [] };
    setSteps(mem.current.steps); setEvents(mem.current.events); setRestored(mem.current.steps.length);
    setHistory(null); setFull("checking");
    setStatus({ kind: "loading", text: "Opening the broadcast…" });
    let pri: Priors | null = null;

    const tick = async () => {
      if (stop) return;
      let again = true;
      try {
        if (!pri) {
          const [p, m] = await Promise.all([loadPriors(), loadStreamModel()]);
          pri = p;
          if (!stop) { setModel(m); setPriors(p); }
        }
        if (!opened) {
          const mode = await listedMode(matchId);
          if (mode && mode !== "normal") throw new StreamError(notScorable(mode), "other");
        }
        const r = await readMatch(matchId, !opened);
        if (stop) return;
        opened = true; misses = 0;
        if (r.players.length !== 12) throw new StreamError(notScorable(r.players.length === 8 ? "street_brawl" : "other"), "other");
        const s = mem.current;
        if (!askedHistory) {                        // once per visit: 12 match histories, in the background
          askedHistory = true;
          playerHistory(r.players.map((p) => ({ team: p.team, hero: p.hero, account: p.account })), Date.now() / 1000, pri)
            .then((h) => { if (!stop) setHistory(h); }).catch(() => {});
        }
        if (r.state === "before") { setStatus({ kind: "waiting", text: "The match has not started yet." }); }
        else {
          const row = streamRow(r, s.past, pri, {}, s.known ?? []);
          if (r.destroyed) {
            if (s.known) {
              const fresh = newObjectiveEvents(s.known, r.destroyed, r.clockS).map((e) => ({ minute: e.t / 60, kind: e.kind, label: e.label, by: e.by }));
              if (fresh.length) { s.events = [...s.events, ...fresh]; setEvents(s.events); }
            }
            s.known = r.destroyed;
          }
          s.past.push({ clockS: r.clockS, souls: row.souls });
          s.steps = [...s.steps, { reading: r, row }];
          setSteps(s.steps);
          save(matchId, { steps: s.steps, events: s.events, past: s.past, known: s.known });
          if (r.state === "over") { again = false; setStatus({ kind: "over", text: "The match has ended." }); }
          else setStatus({ kind: "live", text: r.paused ? "Paused" : "Live" });
        }
      } catch (e) {
        if (stop) return;
        const err = e instanceof StreamError ? e : new StreamError((e as Error).message, "other");
        misses += 1;
        const had = mem.current.steps.length > 0;
        if (err.kind === "not_in_game") { again = false; setStatus({ kind: had ? "over" : "error", text: had ? "The match has ended." : err.message }); }
        else if (err.kind === "not_ready" || err.kind === "network") {
          if (misses > 8) { again = false; setStatus({ kind: "error", text: `${err.message} Gave up after ${misses} tries.` }); }
          else setStatus({ kind: had ? "live" : "waiting", text: had ? "Missed a reading; trying again…" : `${err.message} Trying again every ${POLL_S / 2} seconds…` });
        } else { again = false; setStatus({ kind: "error", text: err.message }); }
      }
      if (again && !stop) timer = window.setTimeout(tick, (opened ? POLL_S : POLL_S / 2) * 1000);
    };
    tick();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [matchId]);

  // after the end: the match data (every minute from the start) appears a few minutes later
  useEffect(() => {
    if (status.kind !== "over") return;
    let stop = false, timer = 0, tries = 0;
    const check = async () => {
      tries += 1;
      try {
        const r = await fetch(`https://api.deadlock-api.com/v1/matches/${matchId}/metadata`);
        if (r.ok) {
          const raw = (await r.json()) as { match_info?: ApiMatch } & ApiMatch;
          if (!isScorable(raw.match_info ?? raw)) { if (!stop) setFull("ready"); return; }
        }
      } catch { /* not there yet */ }
      if (stop) return;
      if (tries >= FULL_CHECKS) setFull("gave_up");
      else timer = window.setTimeout(check, 60_000);
    };
    check();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [status.kind, matchId]);

  const withHistory = (row: Row) => ({ ...row, ...(history?.row ?? {}) });
  const points: LivePoint[] = model ? steps.map(({ reading, row }) => {
    const k = (t: number) => reading.players.filter((p) => p.team === t).reduce((v, p) => v + p.kills, 0);
    return { minute: reading.clockS / 60, p: predict(model, withHistory(row)), souls: row.souls, kills: [k(0), k(1)] };
  }) : [];
  const last = steps[steps.length - 1]?.reading ?? null;
  // starting point: the model at minute 1, before anything has happened, knows only the draft and the players
  if (model && priors && last && steps[0].reading.clockS > 90) {
    const h = (t: number) => last.players.filter((p) => p.team === t).map((p) => p.hero);
    const startRow: Row = { minute: 1, total_souls: 0, ranked: last.ranked ? 1 : 0, ...draftFeatures(h(0), h(1), priors), ...(history?.row ?? {}) };
    points.unshift({ minute: 0, p: predict(model, startRow), souls: 0, kills: [0, 0], start: true });
  }
  const now = points[points.length - 1] ?? null;
  const lost = (t: number) => (mem.current.known ?? []).filter(([, owner]) => owner === t).length;
  const roster = (t: number) => (last?.players ?? []).filter((p) => p.team === t).sort((a, b) => b.souls - a.souls);
  const firstRead = steps[0]?.reading.clockS ?? 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>
            Match {matchId}
            {last && <> · {last.ranked ? "Ranked" : "Unranked"} · {clock(last.clockS)}</>}
            {" · "}<span className={status.kind === "error" ? "error" : "muted"} style={{ fontWeight: 400 }}>{status.text}</span>
          </h2>
          <span className="muted small">
            {teams[0]}'s win chance, one reading every {POLL_S} seconds ({steps.length} so far
            {restored > 0 && <>, {restored} kept from your earlier visit</>}).
          </span>
        </div>
        <span style={{ display: "flex", gap: 8 }}>
          {steps.length > 0 && <button className="btn" title="Forget the readings kept in this browser for this match"
            onClick={() => { forget(matchId); mem.current = { past: [], known: null, steps: [], events: [] }; setSteps([]); setEvents([]); setRestored(0); }}>Clear</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </span>
      </div>

      {now && last && (
        <div className="tiles">
          <div className="tile"><div className="label">Win chance now</div>
            <div className="value">{pc(now.p)} – {pc(1 - now.p)}</div><div className="sub">{teams[0]} – {teams[1]}</div></div>
          <div className="tile"><div className="label">Soul lead</div>
            <div className="value">{Math.abs(now.souls).toLocaleString()}</div><div className="sub">{now.souls >= 0 ? teams[0] : teams[1]}</div></div>
          <div className="tile"><div className="label">Kills</div>
            <div className="value">{now.kills![0]} – {now.kills![1]}</div>
            <div className="sub">{last.players.filter((p) => !p.alive && !p.abandoned && p.team === 0).length} – {last.players.filter((p) => !p.alive && !p.abandoned && p.team === 1).length} dead right now</div></div>
          <div className="tile"><div className="label">Objectives lost</div>
            <div className="value">{mem.current.known ? `${lost(0)} – ${lost(1)}` : "–"}</div><div className="sub">Guardians, Walkers, Base Guardians, Shrines</div></div>
        </div>
      )}

      {last && (
        <div className="rosters">
          {[0, 1].map((t) => (
            <div key={t} className="roster">
              <span className="small"><i className="sw" style={{ background: TEAM_COLOR[t] }} /><b>{teams[t]}</b></span>
              <span className="roster-heroes">
                {roster(t).map((p) => {
                  const h = heroes.get(p.hero);
                  const tip = `${h?.name ?? `Hero ${p.hero}`}: ${p.souls.toLocaleString()} souls, ${p.kills}/${p.deaths}${p.abandoned ? ", left the match" : p.alive ? "" : `, dead for ${Math.ceil(p.respawnS)} s`}`;
                  return h?.image
                    ? <img key={p.hero} src={h.image} alt={h.name} title={tip} width={28} height={28} style={{ opacity: p.alive && !p.abandoned ? 1 : 0.35 }} />
                    : <span key={p.hero} className="hero-fallback" title={tip}>{(h?.name ?? "?").slice(0, 2)}</span>;
                })}
              </span>
            </div>
          ))}
        </div>
      )}

      {points.length > 0 && (
        <>
          <div className="legend">
            <span><i className="sw" style={{ background: TEAM_COLOR[0] }} />{teams[0]} favoured</span>
            <span><i className="sw" style={{ background: TEAM_COLOR[1] }} />{teams[1]} favoured</span>
            {points[0].start && <span><i className="ln" style={{ background: "var(--muted)", height: 2 }} />Dashed: before tracking started, not recorded</span>}
            {events.length > 0 && EVENT_NAMES.filter(([k]) => events.some((e) => e.kind === k)).map(([k, name]) => (
              <span key={k}><b className="num" style={{ marginRight: 4 }}>{EVENT_LETTER[k]}</b>{name} taken</span>
            ))}
          </div>
          <LiveLine points={points} teams={teams} events={events} exact />
        </>
      )}

      {status.kind === "over" && (
        <p className="small" style={{ marginTop: 10 }}>
          {full === "ready"
            ? <>The whole game, every minute from the start, is ready: <Link to={`/win-probability?match=${matchId}`}><b>open the full graph</b></Link>.</>
            : full === "checking"
              ? <>The full graph, every minute from the start, appears a few minutes after the match ends, once the Deadlock API
                  has its final data. Checking every minute (or try the <Link to={`/win-probability?match=${matchId}`}>Win probability page</Link>).</>
              : <>The Deadlock API does not have this match's final data yet; try the <Link to={`/win-probability?match=${matchId}`}>Win probability page</Link> later.</>}
        </p>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Read from the match's live broadcast, which runs a little behind the game itself. The broadcast only sends the
        current state, so {firstRead > 90 ? <>the minutes before {clock(firstRead)}, when tracking started, can't be filled in while the match runs; the
        line starts from the pre-game chance (draft and players only)</> : <>tracking from the first minutes gives the whole graph</>}.
        Readings are kept in this browser for {KEEP_H} hours, so a reload continues the graph. Scored with the stream model:
        current souls, kills, levels, damage, deaths, respawn timers, objectives and the draft
        {history ? <>, plus 30-day player history ({history.loaded} of {history.players} players found)</> : <> (player history still loading)</>}.
      </p>
    </div>
  );
}
