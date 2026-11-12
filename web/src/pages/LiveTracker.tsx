// Follows one match in progress through the live broadcast stream: a reading
// every 30 seconds, scored in the browser with the stream model.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Hero } from "../api";
import { LiveLine, type LiveEvent, type LivePoint } from "../charts/LiveLine";
import { EVENT_LETTER, TEAM_COLOR } from "../charts/WinProb";
import { loadPriors, loadStreamModel } from "../wp/client";
import { newObjectiveEvents, streamRow, type PastLead, type Priors } from "../wp/features";
import { playerHistory } from "../wp/history";
import { predict, type Row, type WebModel } from "../wp/model";
import { readMatch, StreamError, type Reading } from "../wp/stream";

const POLL_S = 30;
const pc = (v: number) => `${Math.round(v * 100)}%`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const EVENT_NAMES: [string, string][] = [["guardian", "Guardian"], ["walker", "Walker"], ["base_guardian", "Base Guardian"], ["shrine", "Shrine"]];

interface Step { reading: Reading; row: Row }                   // row = everything except player history
type Status = { kind: "loading" | "live" | "waiting" | "over" | "error"; text: string };

export function LiveTracker({ matchId, teams, heroes, onClose }:
  { matchId: number; teams: [string, string]; heroes: Map<number, Hero>; onClose: () => void }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [history, setHistory] = useState<{ row: Row; loaded: number; players: number } | null>(null);
  const [model, setModel] = useState<WebModel | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading", text: "Opening the broadcast…" });
  const mem = useRef<{ past: PastLead[]; known: [number, number][] | null; askedHistory: boolean }>({ past: [], known: null, askedHistory: false });

  useEffect(() => {
    let stop = false, timer = 0, misses = 0;
    mem.current = { past: [], known: null, askedHistory: false };
    setSteps([]); setEvents([]); setHistory(null); setStatus({ kind: "loading", text: "Opening the broadcast…" });
    let priors: Priors | null = null;

    const tick = async () => {
      if (stop) return;
      let again = true;
      try {
        if (!priors) {
          const [p, m] = await Promise.all([loadPriors(), loadStreamModel()]);
          priors = p;
          if (!stop) setModel(m);
        }
        const r = await readMatch(matchId, mem.current.past.length === 0);
        if (stop) return;
        misses = 0;
        if (r.players.length !== 12) throw new StreamError("This is not a standard 6v6 match, so the model cannot score it.", "other");
        const s = mem.current;
        if (!s.askedHistory) {                      // once: 12 match histories, in the background
          s.askedHistory = true;
          playerHistory(r.players.map((p) => ({ team: p.team, hero: p.hero, account: p.account })), Date.now() / 1000, priors)
            .then((h) => { if (!stop) setHistory(h); }).catch(() => {});
        }
        if (r.state === "before") { setStatus({ kind: "waiting", text: "The match has not started yet." }); }
        else {
          const row = streamRow(r, s.past, priors, {}, s.known ?? []);
          if (r.destroyed) {
            if (s.known) {
              const fresh = newObjectiveEvents(s.known, r.destroyed, r.clockS).map((e) => ({ minute: e.t / 60, kind: e.kind, label: e.label, by: e.by }));
              if (fresh.length) setEvents((ev) => [...ev, ...fresh]);
            }
            s.known = r.destroyed;
          }
          s.past.push({ clockS: r.clockS, souls: row.souls });
          setSteps((prev) => [...prev, { reading: r, row }]);
          if (r.state === "over") { again = false; setStatus({ kind: "over", text: "The match has ended." }); }
          else setStatus({ kind: "live", text: r.paused ? "Paused" : "Live" });
        }
      } catch (e) {
        if (stop) return;
        const err = e instanceof StreamError ? e : new StreamError((e as Error).message, "other");
        misses += 1;
        const had = mem.current.past.length > 0;
        if (err.kind === "not_in_game") { again = false; setStatus({ kind: had ? "over" : "error", text: had ? "The match has ended." : err.message }); }
        else if (err.kind === "not_ready" || err.kind === "network") {
          if (misses > 8) { again = false; setStatus({ kind: "error", text: `${err.message} Gave up after ${misses} tries.` }); }
          else setStatus({ kind: had ? "live" : "waiting", text: had ? "Missed a reading; trying again…" : `${err.message} Trying again every ${POLL_S / 2} seconds…` });
        } else { again = false; setStatus({ kind: "error", text: err.message }); }
      }
      if (again && !stop) timer = window.setTimeout(tick, (mem.current.past.length ? POLL_S : POLL_S / 2) * 1000);
    };
    tick();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [matchId]);

  const points: LivePoint[] = model ? steps.map(({ reading, row }) => {
    const k = (t: number) => reading.players.filter((p) => p.team === t).reduce((v, p) => v + p.kills, 0);
    return { minute: reading.clockS / 60, p: predict(model, { ...row, ...(history?.row ?? {}) }), souls: row.souls, kills: [k(0), k(1)] };
  }) : [];
  const last = steps[steps.length - 1]?.reading ?? null;
  const now = points[points.length - 1] ?? null;
  const lost = (t: number) => (mem.current.known ?? []).filter(([, owner]) => owner === t).length;
  const roster = (t: number) => (last?.players ?? []).filter((p) => p.team === t).sort((a, b) => b.souls - a.souls);

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
            {teams[0]}'s win chance since you started tracking ({points.length} reading{points.length === 1 ? "" : "s"}, one every {POLL_S} seconds).
          </span>
        </div>
        <button className="btn" onClick={onClose}>Close</button>
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
            {events.length > 0 && EVENT_NAMES.filter(([k]) => events.some((e) => e.kind === k)).map(([k, name]) => (
              <span key={k}><b className="num" style={{ marginRight: 4 }}>{EVENT_LETTER[k]}</b>{name} taken</span>
            ))}
          </div>
          <LiveLine points={points} teams={teams} events={events} exact />
        </>
      )}

      {status.kind === "over" && (
        <p className="small" style={{ marginTop: 10 }}>
          The full graph, from minute 1, appears on the <Link to={`/win-probability?match=${matchId}`}>Win probability page</Link> a
          few minutes after the match ends, once the Deadlock API has its final data.
        </p>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Read from the match's live broadcast, which runs a little behind the game itself. Scored with the stream model:
        current souls, kills, levels, last hits, damage, deaths, respawn timers, objectives and the draft
        {history ? <>, plus 30-day player history ({history.loaded} of {history.players} players found)</> : <> (player history still loading)</>}.
        The graph starts when you start tracking; nothing before that is recorded.
      </p>
    </div>
  );
}
