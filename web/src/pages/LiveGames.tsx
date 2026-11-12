import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi, type HeroesResponse } from "../api";
import { TEAM_COLOR } from "../charts/WinProb";
import { liveGames, type LiveGame } from "../wp/client";
import { LiveTracker } from "./LiveTracker";

const TEAMS: [string, string] = ["Hidden King", "Archmother"];
const POLL_S = 30;
const pc = (v: number) => `${Math.round(v * 100)}%`;

export function LiveGames() {
  const heroes = useApi<HeroesResponse>("heroes?queue=all&rank=all&period=all");
  const hero = new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h]));
  const [games, setGames] = useState<LiveGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [params, setParams] = useSearchParams();
  const selected = /^\d+$/.test(params.get("match") ?? "") ? Number(params.get("match")) : null;   // in the address, so a tracked match can be shared
  const select = (id: number | null) => { setParams(id == null ? {} : { match: String(id) }); if (id != null) window.scrollTo({ top: 0, behavior: "smooth" }); };
  const [query, setQuery] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); if (/^\d+$/.test(query.trim())) select(Number(query.trim())); };
  const [shown, setShown] = useState(15);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const g = await liveGames();
        if (stop) return;
        setGames(g); setError(null); setUpdated(new Date());
      } catch (e) { if (!stop) setError((e as Error).message); }
    };
    tick();
    const id = window.setInterval(() => { if (!document.hidden) tick(); }, POLL_S * 1000);   // no polling in a background tab
    return () => { stop = true; window.clearInterval(id); };
  }, []);

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
        Games being played right now, with the model's current win chance for each team. Track one of them, or
        any other match by its ID, to watch its graph grow. The list refreshes every {POLL_S} seconds.
      </p>
      {error && <p className="error">{error}</p>}

      <form className="filters" onSubmit={submit}>
        <div className="filter">
          <label htmlFor="track-id">Track any match in progress by its ID</label>
          <input id="track-id" inputMode="numeric" placeholder="e.g. 136022062" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={!/^\d+$/.test(query.trim())}>Track</button>
        <span className="muted small" style={{ alignSelf: "center" }}>
          Works for your own game too, not only the listed ones. Up to 6 different matches an hour.
        </span>
      </form>

      {selected != null && <LiveTracker key={selected} matchId={selected} teams={TEAMS} heroes={hero} onClose={() => select(null)} />}

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
                    <td><button className="btn" onClick={() => select(g.match_id)}>Track</button></td>
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
          <b>What the list uses.</b> The list only has team souls, objectives, heroes and leavers, so its win
          chances come from the <b>live model</b>, which picks the winner about 72% of the time across a game and
          treats every player as average. Game time is estimated: the list gives when a match was created, and the
          in-game clock starts about 2 minutes later. <b>Tracking a match</b> reads its live broadcast instead: exact
          clock, every player's current stats, and a fuller model. The list is the 200 most-watched games the
          Deadlock API can see, not every game being played.
        </span>
      </p>
    </>
  );
}
