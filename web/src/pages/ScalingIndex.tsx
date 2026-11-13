import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { sliceQuery, useApi, type HeroesResponse, type IndexResponse, type IndexRow } from "../api";
import { ScalingBars } from "../charts/ScalingBars";
import { DemoBanner, LengthCaveat, Loading, ViewToggle } from "../components/ui";
import { FilterBar, useMeta, useSlice, useSliceSearch } from "../filters";
import { int, pct, pp } from "../format";

// "By game minute": souls growth from FROM to TO minutes (pipeline/at_minute.py).
// 12 = about the end of laning; 30 = late, while about 80% of matches are still running.
const FROM = 12, TO = 30;
interface MinutePoint { minute: number; n: number; lead: number; lead_low: number; lead_high: number; share: number; share_low: number; share_high: number; enough: boolean }
interface AtMinuteResponse { curves: { hero_id: number; points: MinutePoint[] }[] }
interface GrowthRow extends IndexRow { share_from: number; share_to: number; lead_from: number; lead_to: number; n_to: number }

const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const pts = (v: number, d = 1) => `${signed(v, d)} pts`;

/** Growth in own souls vs the match average between FROM and TO, with a conservative 95% CI
 *  (the two minutes' intervals combined as if independent; they share matches, so the true one is narrower). */
function growthRows(curves: AtMinuteResponse["curves"]): GrowthRow[] {
  const out: GrowthRow[] = [];
  for (const c of curves) {
    const a = c.points.find((p) => p.minute === FROM), b = c.points.find((p) => p.minute === TO);
    if (!a || !b || !a.enough || !b.enough) continue;
    const g = b.share - a.share;
    const half = Math.hypot((a.share_high - a.share_low) / 2, (b.share_high - b.share_low) / 2);
    out.push({ hero_id: c.hero_id, pp_per_10min: g, ci_low: g - half, ci_high: g + half, games: b.n, win_rate: NaN,
      wr_ci_low: NaN, wr_ci_high: NaN, share_from: a.share, share_to: b.share, lead_from: a.lead, lead_to: b.lead, n_to: b.n });
  }
  return out.sort((x, y) => x.pp_per_10min - y.pp_per_10min);
}

export function ScalingIndex() {
  const [slice] = useSlice();
  const search = useSliceSearch();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const mode = params.get("by") === "minute" ? "minute" : "length";
  const setMode = (m: "length" | "minute") => { const p = new URLSearchParams(params); if (m === "minute") p.set("by", "minute"); else p.delete("by"); setParams(p); };
  const [view, setView] = useState<"chart" | "table">("chart");
  const index = useApi<IndexResponse>(mode === "length" ? `scaling-index?${sliceQuery(slice)}` : null);
  const minute = useApi<AtMinuteResponse>(mode === "minute" ? `at-minute?${sliceQuery(slice)}` : null);
  const heroes = useApi<HeroesResponse>(`heroes?${sliceQuery(slice)}`);
  const byId = useMemo(() => new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h])), [heroes.data]);
  const rows = index.data?.heroes ?? [];
  const growth = useMemo(() => growthRows(minute.data?.curves ?? []), [minute.data]);
  const name = (id: number) => byId.get(id)?.name ?? `Hero ${id}`;

  return (
    <>
      <h1>Scaling index</h1>
      <p className="lede">
        Who gets stronger the longer the game goes? Two ways to measure it: win rate by how long games last, or how a
        hero's share of the souls grows between fixed minutes of every game.
      </p>
      <div className="seg" role="group" aria-label="Measure" style={{ marginBottom: 14 }}>
        <button aria-pressed={mode === "length"} onClick={() => setMode("length")}>By game length (win rate)</button>
        <button aria-pressed={mode === "minute"} onClick={() => setMode("minute")}>By game minute (souls)</button>
      </div>
      <DemoBanner />
      {mode === "length" ? (
        <>
          <p className="muted small" style={{ margin: "0 0 12px", maxWidth: "80ch" }}>
            Percentage points of win rate gained per extra 10 minutes of game length, fit only on buckets with at least{" "}
            {meta?.min_games_per_bin.toLocaleString() ?? "–"} games and <b>adjusted for hero strength</b>.
          </p>
          <p className="note">
            <span aria-hidden>ⓘ</span>
            <span>
              <b>Why adjust?</b> Short games are stomps, and the stronger side wins stomps. So a plain slope through
              the power curve calls every strong hero “early-game” and every weak hero “late-game”: across heroes it
              correlates about −0.8 with overall win rate. The adjusted index first removes the part of each bucket's
              win rate that the hero's overall win rate explains (estimated across all heroes), then fits the slope
              on what is left. The table view shows the plain slope next to it.
            </span>
          </p>
        </>
      ) : (
        <p className="muted small" style={{ margin: "0 0 12px", maxWidth: "80ch" }}>
          How much a hero's own souls, compared with the average player in the same match, grow from minute {FROM} to
          minute {TO}, in percentage points. +5 pts = 5 points more above the match average at {TO} than at {FROM}. Game
          length plays no part, so stomps can't bias it; it measures who farms into the late game, not who wins it.
        </p>
      )}
      <FilterBar sample={mode === "length" ? index.data?.sample : heroes.data?.sample} />
      {mode === "length" && <LengthCaveat />}
      {(index.error || minute.error) && <p className="error">{index.error || minute.error}</p>}
      <Loading loading={index.loading || minute.loading || heroes.loading}>
        <div className="card">
          <div className="card-head">
            <div className="legend" style={{ margin: 0 }}>
              {mode === "length" ? (
                <>
                  <span><i className="sw" style={{ background: "var(--early)" }} />Early-game (wins short games)</span>
                  <span><i className="sw" style={{ background: "var(--series)" }} />Late-game (wins long games)</span>
                </>
              ) : (
                <>
                  <span><i className="sw" style={{ background: "var(--early)" }} />Share of souls shrinks after minute {FROM}</span>
                  <span><i className="sw" style={{ background: "var(--series)" }} />Share of souls grows</span>
                </>
              )}
              <span><i className="ln" style={{ background: "var(--ink-2)", height: 1 }} />95% CI</span>
              <span><i className="sw" style={{ background: "var(--ink-2)", opacity: 0.4 }} />Faded: CI includes 0</span>
            </div>
            <ViewToggle value={view} onChange={setView} />
          </div>
          {mode === "length" ? (view === "chart" ? (
            <ScalingBars rows={rows} heroes={byId} linkSearch={search} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Hero</th><th>pp / 10 min (adjusted)</th><th>95% CI</th><th>Plain slope</th><th>Win rate</th><th>Games</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.hero_id}>
                      <td><Link to={`/heroes/${r.hero_id}${search}`}>{name(r.hero_id)}</Link></td>
                      <td>{pp(r.pp_per_10min)}</td><td>{pp(r.ci_low)} to {pp(r.ci_high)}</td>
                      <td>{r.raw_pp_per_10min != null ? pp(r.raw_pp_per_10min) : "–"}</td>
                      <td>{pct(r.win_rate)}</td><td>{int(r.games)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )) : view === "chart" ? (
            <ScalingBars rows={growth} heroes={byId} linkSearch={search} fmt={pts} unit={`from minute ${FROM} to ${TO}`}
              tooltip={(r) => {
                const g = r as GrowthRow;
                return [`own souls vs match average: ${signed(g.share_from)}% at ${FROM} min → ${signed(g.share_to)}% at ${TO} min`,
                  `95% CI ${pts(g.ci_low)} to ${pts(g.ci_high)}`,
                  `team soul lead ${signed(g.lead_from, 2)}% → ${signed(g.lead_to, 2)}%`, `${int(g.n_to)} games still running at ${TO} min`];
              }} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Hero</th><th>Growth</th><th>95% CI</th><th>Own souls at {FROM} min</th><th>at {TO} min</th>
                  <th>Team lead at {FROM} min</th><th>at {TO} min</th><th>Games at {TO} min</th></tr></thead>
                <tbody>
                  {growth.map((r) => (
                    <tr key={r.hero_id}>
                      <td><Link to={`/heroes/${r.hero_id}${search}`}>{name(r.hero_id)}</Link></td>
                      <td>{pts(r.pp_per_10min)}</td><td>{pts(r.ci_low)} to {pts(r.ci_high)}</td>
                      <td>{signed(r.share_from)}%</td><td>{signed(r.share_to)}%</td>
                      <td>{signed(r.lead_from, 2)}%</td><td>{signed(r.lead_to, 2)}%</td><td>{int(r.n_to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Loading>
      {mode === "minute" && (
        <p className="muted small" style={{ marginTop: 10, maxWidth: "80ch" }}>
          Only matches still running at minute {TO} count there (about 80% of them), and matches where someone left are not
          counted. The interval treats the two minutes as independent samples; they share matches, so it is a little wider
          than it needs to be. Each hero page shows the full curve for every minute from 3 to 45.
        </p>
      )}
    </>
  );
}
