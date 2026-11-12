import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi, type HeroesResponse } from "../api";
import { EVENT_LETTER, TEAM_COLOR, WinProb, type WpEvent, type WpPoint } from "../charts/WinProb";
import { Loading, ViewToggle } from "../components/ui";
import { pct } from "../format";

interface Player { team: number; hero_id: number; kills: number; deaths: number; net_worth: number }
interface MatchSummary {
  match_id: number; label: string; blurb: string; start_time: string; duration_s: number; queue: string;
  average_badge: number | null; winner: number; truncated: boolean; players: Player[];
  lowest_winner_chance: number | null;
}
interface MatchFull extends MatchSummary { points: WpPoint[]; events: WpEvent[] }
interface ModelInfo { held_out_day: string | null; saved_at: string | null }
interface ListResponse { generated_at: string; model: ModelInfo; max_minute: number; lookup: boolean; matches: MatchSummary[] }
interface MatchResponse { model: ModelInfo; max_minute: number; match: MatchFull }

// Team0 / Team1 in the match data
const TEAMS: [string, string] = ["Hidden King", "Archmother"];
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const EVENT_NAMES: [string, string][] = [["guardian", "Guardian"], ["walker", "Walker"], ["base_guardian", "Base Guardian"],
  ["shrine", "Shrine"], ["patron", "Patron"], ["mid_boss", "Mid-Boss"]];

export function WinProbability() {
  const [params, setParams] = useSearchParams();
  const list = useApi<ListResponse>("win-probability");
  const heroes = useApi<HeroesResponse>("heroes?queue=all&rank=all&period=all");
  const chosen = params.get("match") ?? (list.data?.matches[0] ? String(list.data.matches[0].match_id) : null);
  const { data, error, loading } = useApi<MatchResponse>(chosen ? `win-probability/${chosen}` : null);
  const [query, setQuery] = useState("");
  const [showLive, setShowLive] = useState(false);
  const [view, setView] = useState<"chart" | "table">("chart");
  const hero = new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h]));
  const m = data && String(data.match.match_id) === chosen ? data.match : null;

  const pick = (id: string | number) => setParams({ match: String(id) });
  const submit = (e: FormEvent) => { e.preventDefault(); if (/^\d+$/.test(query.trim())) pick(query.trim()); };

  // headline numbers for the selected match, all from the winner's point of view
  const pw = m ? m.points.map((p) => (m.winner === 0 ? p.p : 1 - p.p)) : [];
  const low = pw.length ? Math.min(...pw) : null;
  const lowAt = low != null && m ? m.points[pw.indexOf(low)].minute : null;
  const flips = m ? m.points.filter((p, i) => i > 0 && (p.p - 0.5) * (m.points[i - 1].p - 0.5) < 0).length : 0;
  let swing = 0, swingAt = 0;
  if (m) m.points.forEach((p, i) => { if (i > 0 && Math.abs(p.p - m.points[i - 1].p) > Math.abs(swing)) { swing = p.p - m.points[i - 1].p; swingAt = p.minute; } });

  return (
    <>
      <h1>Win probability</h1>
      <p className="lede">
        The model's win chance for each team at every minute of a match, with objectives and kills on the same
        timeline. The model has never seen these matches.
      </p>
      {list.error && <p className="error">{list.error}</p>}

      <div className="match-picker" role="group" aria-label="Example matches">
        {(list.data?.matches ?? []).map((x) => (
          <button key={x.match_id} className="card match-card" aria-pressed={String(x.match_id) === chosen} onClick={() => pick(x.match_id)}>
            <b>{x.label || `Match ${x.match_id}`}</b>
            <span className="muted small">{x.blurb}</span>
            <span className="small">
              {clock(x.duration_s)} · {x.queue} · {TEAMS[x.winner]} won
              {x.lowest_winner_chance != null && <> · low point {pct(x.lowest_winner_chance, x.lowest_winner_chance < 0.01 ? 1 : 0)}</>}
            </span>
          </button>
        ))}
      </div>

      {list.data?.lookup ? (
        <form className="filters" onSubmit={submit}>
          <div className="filter">
            <label htmlFor="match-id">Any match ID</label>
            <input id="match-id" inputMode="numeric" placeholder="e.g. 135545002" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button type="submit" className="btn" disabled={!/^\d+$/.test(query.trim())}>Show graph</button>
          <span className="muted small">Looked up in the data lake and scored on the spot; takes up to a minute. Matches appear about an hour after they end.</span>
        </form>
      ) : list.data && (
        <p className="muted small" style={{ margin: "0 0 16px" }}>
          This online version shows example matches. Looking up any match by ID needs the project running with its backend.
        </p>
      )}

      {error && <p className="error">{error}</p>}
      <Loading loading={loading || list.loading}>
        {m && (
          <>
            <div className="tiles">
              <Tile label="Result" value={`${TEAMS[m.winner]} won`} sub={`${clock(m.duration_s)} · ${m.queue} · match ${m.match_id}`} />
              <Tile label="Winner's lowest win chance" value={low != null ? pct(low, low < 0.01 ? 1 : 0) : "–"} sub={lowAt != null ? `at minute ${lowAt}` : ""} />
              <Tile label="Favourite changed" value={`${flips} time${flips === 1 ? "" : "s"}`} sub="line crossing 50%" />
              <Tile label="Biggest one-minute swing" value={`${Math.round(Math.abs(swing) * 100)} pts`}
                    sub={swing ? `toward ${TEAMS[swing > 0 ? 0 : 1]} at minute ${swingAt}` : ""} />
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">
                <div>
                  <h2>{m.label || `Match ${m.match_id}`}</h2>
                  <span className="muted small">
                    Line = {TEAMS[0]}'s win chance; {TEAMS[1]}'s is the rest to 100%. Markers show objectives taken, by team.
                  </span>
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <label className="small"><input type="checkbox" checked={showLive} onChange={(e) => setShowLive(e.target.checked)} /> Live model</label>
                  <ViewToggle value={view} onChange={setView} />
                </div>
              </div>

              <div className="rosters">
                {[0, 1].map((t) => (
                  <div key={t} className="roster">
                    <span className="small"><i className="sw" style={{ background: TEAM_COLOR[t] }} /><b>{TEAMS[t]}</b>{m.winner === t && " · won"}</span>
                    <span className="roster-heroes">
                      {m.players.filter((p) => p.team === t).map((p) => {
                        const h = hero.get(p.hero_id);
                        const tip = `${h?.name ?? `Hero ${p.hero_id}`}: ${p.kills} kills, ${p.deaths} deaths, ${p.net_worth.toLocaleString()} souls`;
                        return h?.image
                          ? <img key={p.hero_id} src={h.image} alt={h.name} title={tip} width={28} height={28} loading="lazy" />
                          : <span key={p.hero_id} className="hero-fallback" title={tip}>{(h?.name ?? "?").slice(0, 2)}</span>;
                      })}
                    </span>
                  </div>
                ))}
              </div>

              {view === "chart" ? (
                <>
                  <div className="legend">
                    <span><i className="ln" style={{ background: "var(--ink)" }} />Win chance (full model)</span>
                    {showLive && <span><i className="ln" style={{ background: "var(--muted)" }} />Live model (dashed)</span>}
                    <span><i className="bd" style={{ background: TEAM_COLOR[0], opacity: 0.45 }} />{TEAMS[0]} ahead (row A)</span>
                    <span><i className="bd" style={{ background: TEAM_COLOR[1], opacity: 0.45 }} />{TEAMS[1]} ahead (row B)</span>
                    {EVENT_NAMES.map(([k, n]) => <span key={k}><b>{EVENT_LETTER[k]}</b> {n}</span>)}
                  </div>
                  <WinProb points={m.points} events={m.events} durationS={m.duration_s} winner={m.winner} teams={TEAMS} showLive={showLive} />
                </>
              ) : (
                <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
                  <table>
                    <thead><tr><th>Minute</th><th>{TEAMS[0]}</th><th>{TEAMS[1]}</th><th>Live model ({TEAMS[0]})</th>
                      <th>Soul lead ({TEAMS[0]})</th><th>Kills</th><th>Events</th></tr></thead>
                    <tbody>
                      {m.points.map((p) => (
                        <tr key={p.minute}>
                          <td>{p.minute}</td><td>{pct(p.p)}</td><td>{pct(1 - p.p)}</td><td>{pct(p.p_live)}</td>
                          <td>{p.souls.toLocaleString()}</td><td>{p.kills0}–{p.kills1}</td>
                          <td style={{ textAlign: "left" }}>
                            {m.events.filter((e) => Math.ceil(e.t / 60) === p.minute).map((e) => `${e.label} (${TEAMS[e.by]})`).join(", ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {m.truncated && (
                <p className="muted small" style={{ margin: "6px 0 0" }}>
                  This match ran past minute {data!.max_minute}, where the model's timeline ends; the line stops there.
                </p>
              )}
            </div>
          </>
        )}
      </Loading>

      <p className="note">
        <span aria-hidden>ⓘ</span>
        <span>
          <b>How to read it.</b> A 70% chance means teams in this position won 70% of the time in matches the model
          never saw; it is not a guarantee, and comebacks from 5% do happen about 1 time in 20. The example matches are
          from {list.data?.model.held_out_day ?? "the held-out day"}, the day the model was tested on, not trained on.
          Player stats (souls, kills) are recorded every 3 to 5 minutes, so between those the model uses the last
          values; objectives and deaths are exact. The <b>live model</b> uses only what is visible while a game is
          running (team souls, objectives, heroes, players), so it reacts less to fights. Accuracy and calibration of
          both models are on the Model check page.
        </span>
      </p>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
