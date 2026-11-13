// Hero page sections: strength at each game minute, and partners / match-ups.
import { useState } from "react";
import { Link } from "react-router-dom";
import { sliceQuery, useApi, type Hero, type Slice } from "../api";
import { AtMinute, type MinutePoint } from "../charts/AtMinute";
import { int, pct } from "../format";
import { Loading, ViewToggle } from "./ui";

interface AtMinuteRow {
  minute: number; n: number; lead: number; lead_low: number; lead_high: number;
  share: number; share_low: number; share_high: number; enough: boolean;
}
interface AtMinuteResponse { curves: { hero_id: number; points: AtMinuteRow[] }[] }
interface PairRow { other: number; n: number; win_rate: number; expected: number; effect: number; ci_low: number; ci_high: number }
interface PairsResponse {
  first_day: string; last_day: string; min_games: number; leavers_excluded?: boolean;
  cols: string[];                                             // order of the values in each row
  heroes: Record<string, { with: number[][]; against: number[][] }>;
}
const toRows = (cols: string[], rows: number[][]): PairRow[] =>
  rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])) as unknown as PairRow);

const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

export function HeroAtMinute({ id, name, slice }: { id: number; name: string; slice: Slice }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const r = useApi<AtMinuteResponse>(`at-minute?${sliceQuery(slice, { hero_id: id })}`);
  const rows = r.data?.curves.find((c) => c.hero_id === id)?.points ?? [];
  const pts = (k: "lead" | "share"): MinutePoint[] =>
    rows.map((p) => ({ minute: p.minute, n: p.n, value: p[k], low: p[`${k}_low`], high: p[`${k}_high`], enough: p.enough }));

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2>Strength at each minute</h2>
          <span className="muted small">
            The game state with {name} at fixed minutes, instead of win rate by game length. Zero is the average hero.
          </span>
        </div>
        <ViewToggle value={view} onChange={setView} />
      </div>
      {r.error && <p className="error">{r.error}</p>}
      <Loading loading={r.loading}>
        {view === "chart" ? (
          <div className="pair-grid">
            <div>
              <h3 className="sub-h">Team's soul lead</h3>
              <p className="muted small" style={{ margin: "0 0 6px" }}>% of all souls in the match: +2% = the team holds 52% of them</p>
              <AtMinute points={pts("lead")} label={`${name}: team soul lead by game minute`}
                describe={(p) => `${name}'s team's soul lead at ${p.minute} min, as % of all souls`} />
            </div>
            <div>
              <h3 className="sub-h">{name}'s own souls</h3>
              <p className="muted small" style={{ margin: "0 0 6px" }}>vs the average player in the match: +10% = 10% more souls</p>
              <AtMinute points={pts("share")} label={`${name}: own souls vs lobby average by game minute`} color="var(--cat-2)"
                describe={(p) => `${name}'s souls vs the match average at ${p.minute} min`} />
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Minute</th><th>Team soul lead</th><th>95% CI</th><th>Own souls vs average</th><th>95% CI</th><th>Games</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.minute} className={p.enough ? "" : "dim"}>
                    <td>{p.minute}</td><td>{signed(p.lead, 2)}%</td><td>{signed(p.lead_low, 2)} to {signed(p.lead_high, 2)}</td>
                    <td>{signed(p.share, 1)}%</td><td>{signed(p.share_low, 1)} to {signed(p.share_high, 1)}</td><td>{int(p.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loading>
      <p className="muted small" style={{ margin: "10px 0 0" }}>
        From the stat snapshots the game records every 3 minutes to 15:00, then every 5. Only matches still running at a
        minute count there, so after about 30 minutes the sample leans toward closer games.
      </p>
    </div>
  );
}

function PairTable({ rows, heroes, search, verb }: { rows: PairRow[]; heroes: Map<number, Hero>; search: string; verb: string }) {
  const ext = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.ci_low), Math.abs(r.ci_high))));
  return (
    <table className="pair-table">
      <thead><tr><th style={{ textAlign: "left" }}>Hero</th><th style={{ textAlign: "left" }}>Effect</th><th>95% CI</th><th>Win rate</th><th>Games</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const h = heroes.get(r.other);
          const w = (Math.abs(r.effect) / ext) * 50;
          return (
            <tr key={r.other} title={`${verb} ${h?.name ?? r.other}: ${pct(r.win_rate)} won, ${pct(r.expected)} expected from the two heroes' own win rates`}>
              <td style={{ textAlign: "left" }}>
                <Link to={`/heroes/${r.other}${search}`} className="pair-hero">
                  {h?.image && <img src={h.image} alt="" width={20} height={20} />}{h?.name ?? `Hero ${r.other}`}
                </Link>
              </td>
              <td style={{ textAlign: "left" }}>
                <span className="effect-bar" aria-hidden>
                  <i style={r.effect >= 0 ? { left: "50%", width: `${w}%`, background: "var(--series)" }
                                         : { right: "50%", width: `${w}%`, background: "var(--early)" }} />
                </span>
                <span className="num">{signed(r.effect)} pp</span>
              </td>
              <td>{signed(r.ci_low)} to {signed(r.ci_high)}</td>
              <td>{pct(r.win_rate)}</td>
              <td>{int(r.n)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function HeroPairs({ id, name, heroes, search, slice }: { id: number; name: string; heroes: Map<number, Hero>; search: string; slice: Slice }) {
  const r = useApi<PairsResponse>(`hero-pairs?${sliceQuery(slice)}`);
  const [all, setAll] = useState(false);
  const raw = r.data?.heroes[String(id)];
  const mine = raw && r.data ? { with: toRows(r.data.cols, raw.with), against: toRows(r.data.cols, raw.against) } : undefined;
  const pick = (rows: PairRow[]) => (all ? rows : [...rows.slice(0, 5), ...rows.slice(-5)]);
  const blocks: [string, string, string, PairRow[]][] = mine ? [
    ["Partners", `On the same team as ${name}`, "With", mine.with],
    ["Match-ups", `${name} against`, "Against", mine.against],
  ] : [];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2>Best and worst partners and match-ups</h2>
          <span className="muted small">
            How much more (or less) often {name}'s side wins than the two heroes' own win rates predict, in percentage points.
            {r.data && <> {r.data.first_day} to {r.data.last_day}, for the filters above; pairs with at least {int(r.data.min_games)} games
              {r.data.leavers_excluded && ", matches where someone left not counted"}.</>}
          </span>
        </div>
        <button className="btn" onClick={() => setAll((v) => !v)}>{all ? "Top and bottom 5" : "Show all"}</button>
      </div>
      {r.error && <p className="error">{r.error}</p>}
      <Loading loading={r.loading}>
        {r.data && !mine && <p className="muted">No pairs with enough games for {name} in this slice.</p>}
        <div className="pair-grid">
          {blocks.map(([title, sub, verb, rows]) => (
            <div key={title}>
              <h3 className="sub-h">{title}</h3>
              <p className="muted small" style={{ margin: "0 0 6px" }}>{sub}: best first{all ? "" : "; the 5 best and the 5 worst"}</p>
              <div className="table-wrap"><PairTable rows={pick(rows)} heroes={heroes} search={search} verb={verb} /></div>
            </div>
          ))}
        </div>
      </Loading>
      <p className="muted small" style={{ margin: "10px 0 0" }}>
        Ordered by the effect pulled toward zero for pairs with fewer games, the same way the win model treats draft
        synergy and counters. Most effects are within ±2 points: the draft matters, but no pair decides a game.
      </p>
    </div>
  );
}
