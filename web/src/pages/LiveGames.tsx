import { useEffect, useRef, useState } from "react";
import { useApi, type HeroesResponse } from "../api";
import { LiveLine, type LivePoint } from "../charts/LiveLine";
import { TEAM_COLOR } from "../charts/WinProb";
import { liveGames, type LiveGame } from "../wp/client";

const TEAMS: [string, string] = ["Hidden King", "Archmother"];
const POLL_S = 30;
const pc = (v: number) => `${Math.round(v * 100)}%`;

export function LiveGames() {
  const heroes = useApi<HeroesResponse>("heroes?queue=all&rank=all&period=all");
  const hero = new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h]));
  const [games, setGames] = useState<LiveGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [shown, setShown] = useState(15);
  const history = useRef(new Map<number, LivePoint[]>());       // every poll since the page opened, per match

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const g = await liveGames();
        if (stop) return;
        for (const x of g) {
          const h = history.current.get(x.match_id) ?? [];
          h.push({ minute: x.minute, p: x.p, souls: x.souls });
          history.current.set(x.match_id, h);
        }
        setGames(g); setError(null); setUpdated(new Date());
      } catch (e) { if (!stop) setError((e as Error).message); }
    };
    tick();
    const id = window.setInterval(() => { if (!document.hidden) tick(); }, POLL_S * 1000);   // no polling in a background tab
    return () => { stop = true; window.clearInterval(id); };
  }, []);

  const sel = games?.find((g) => g.match_id === selected) ?? null;
  const ended = selected != null && games != null && !sel;
  const points = selected != null ? history.current.get(selected) ?? [] : [];

  const icons = (ids: number[]) => (
    <span className="roster-heroes">
      {ids.map((id) => {
        const h = hero.get(id);
        return h?.image ? <img key={id} src={h.image} alt={h.name} title={h.name} width={24} height={24} loading="lazy" />
                        : <span key={id} className="hero-fallback" title={h?.name}>{(h?.name ?? "?").slice(0, 2)}</span>;
      })}
    </span>
  );

  return (
    <>
      <h1>Live games</h1>
      <p className="lede">
        Games being played right now, with the model's current win chance for each team. Pick one to watch its
        graph grow. Refreshes every {POLL_S} seconds.
      </p>
      {error && <p className="error">{error}</p>}

      {selected != null && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div>
              <h2>Match {selected}{ended && " · no longer listed (it has probably ended)"}</h2>
              <span className="muted small">
                {TEAMS[0]}'s win chance since you opened this page ({points.length} reading{points.length === 1 ? "" : "s"}).
                {sel && <> Now: <b>{pc(sel.p)}</b> {TEAMS[0]} · <b>{pc(1 - sel.p)}</b> {TEAMS[1]} · objectives lost {sel.lost[0]}–{sel.lost[1]}.</>}
              </span>
            </div>
            <button className="btn" onClick={() => setSelected(null)}>Close</button>
          </div>
          {sel && (
            <div className="rosters">
              {[0, 1].map((t) => (
                <div key={t} className="roster">
                  <span className="small"><i className="sw" style={{ background: TEAM_COLOR[t] }} /><b>{TEAMS[t]}</b></span>
                  {icons(sel.heroes[t])}
                </div>
              ))}
            </div>
          )}
          <LiveLine points={points} teams={TEAMS} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <h2>In progress</h2>
            <span className="muted small">
              {games ? `${games.length} standard 6v6 games listed by the Deadlock API, most-watched first` : "Loading games and the model…"}
              {updated && ` · updated ${updated.toLocaleTimeString()}`}
            </span>
          </div>
        </div>
        {games && games.length === 0 && <p className="muted">No standard 6v6 games are listed right now.</p>}
        {games && games.length > 0 && (
          <div className="table-wrap">
            <table className="live-table">
              <thead><tr><th style={{ textAlign: "left" }}>{TEAMS[0]}</th><th style={{ textAlign: "left" }}>Win chance</th>
                <th style={{ textAlign: "left" }}>{TEAMS[1]}</th><th>Game time</th><th>Soul lead</th><th>Queue</th><th>Watching</th><th /></tr></thead>
              <tbody>
                {games.slice(0, shown).map((g) => (
                  <tr key={g.match_id} aria-selected={g.match_id === selected}>
                    <td style={{ textAlign: "left" }}>{icons(g.heroes[0])}</td>
                    <td style={{ textAlign: "left", minWidth: 190 }}>
                      {/* two-part meter: each team's share of 100%, numbers in text beside it */}
                      <span className="meter" role="img" aria-label={`${TEAMS[0]} ${pc(g.p)}, ${TEAMS[1]} ${pc(1 - g.p)}`}>
                        <i style={{ width: `calc(${g.p * 100}% - 1px)`, background: TEAM_COLOR[0] }} />
                        <i style={{ width: `calc(${(1 - g.p) * 100}% - 1px)`, background: TEAM_COLOR[1] }} />
                      </span>
                      <span className="num small"> {pc(g.p)} – {pc(1 - g.p)}</span>
                    </td>
                    <td style={{ textAlign: "left" }}>{icons(g.heroes[1])}</td>
                    <td>~{Math.floor(g.minute)} min</td>
                    <td>{Math.abs(g.souls).toLocaleString()} {g.souls >= 0 ? TEAMS[0] : TEAMS[1]}</td>
                    <td>{g.ranked ? "Ranked" : "Unranked"}</td>
                    <td>{g.spectators}</td>
                    <td><button className="btn" onClick={() => { setSelected(g.match_id); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Watch</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {games && games.length > shown && (
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setShown((n) => n + 30)}>Show more ({games.length - shown} left)</button>
        )}
      </div>

      <p className="note">
        <span aria-hidden>ⓘ</span>
        <span>
          <b>What this uses.</b> While a game is running, only team souls, objectives, heroes and leavers are public,
          so this is the <b>live model</b>: it picks the winner about 72% of the time across a game, a little less
          than the full model, and it treats every player as average (no player history in the browser). Game time is
          counted from when the match was created, so it can run a minute or two ahead of the in-game clock. The
          graph starts when you open the page; nothing is recorded before that. The list is whatever the Deadlock API
          shows, not every game being played.
        </span>
      </p>
    </>
  );
}
