// Scaling index, "Compare ranks": does who-scales change with skill? Ranked matches only,
// one value per hero per rank bracket, for either measure on the page (win rate by game
// length, or souls growth from minute FROM to TO).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApi, type HeroesResponse, type IndexResponse } from "../api";
import { BRACKETS, RankDots, RankLegend, type RankRow } from "../charts/RankDots";
import { useMeta, useSlice, useSliceSearch } from "../filters";
import { int } from "../format";
import { Loading, ViewToggle } from "./ui";

interface MinutePoint { minute: number; n: number; share: number; share_low: number; share_high: number; enough: boolean }
interface AtMinuteResponse { curves: { hero_id: number; points: MinutePoint[] }[] }
const RANKS = ["low", "mid", "high"] as const;
const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

function corr(a: number[], b: number[]) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}

export function RankCompare({ from, to }: { from: number; to: number }) {
  const meta = useMeta();
  const [slice, update] = useSlice();
  const search = useSliceSearch();
  const [measure, setMeasure] = useState<"length" | "minute">("length");
  const [view, setView] = useState<"chart" | "table">("chart");
  const q = (rank: string) => `queue=ranked&rank=${rank}&period=${slice.period}`;
  const idx = RANKS.map((r) => useApi<IndexResponse>(measure === "length" ? `scaling-index?${q(r)}` : null));   // eslint-disable-line react-hooks/rules-of-hooks
  const am = RANKS.map((r) => useApi<AtMinuteResponse>(measure === "minute" ? `at-minute?${q(r)}` : null));      // eslint-disable-line react-hooks/rules-of-hooks
  const heroes = useApi<HeroesResponse>(`heroes?queue=ranked&rank=all&period=${slice.period}`);
  const byId = useMemo(() => new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h])), [heroes.data]);
  const loading = [...idx, ...am, heroes].some((r) => r.loading);
  const error = [...idx, ...am, heroes].find((r) => r.error)?.error;

  const rows: RankRow[] = useMemo(() => {
    const per: Map<number, { v: number; lo: number; hi: number; n: number }>[] = RANKS.map((_, k) => {
      const m = new Map<number, { v: number; lo: number; hi: number; n: number }>();
      if (measure === "length") {
        for (const r of idx[k].data?.heroes ?? []) m.set(r.hero_id, { v: r.pp_per_10min, lo: r.ci_low, hi: r.ci_high, n: r.games });
      } else {
        for (const c of am[k].data?.curves ?? []) {
          const a = c.points.find((p) => p.minute === from), b = c.points.find((p) => p.minute === to);
          if (!a || !b || !a.enough || !b.enough) continue;
          const g = b.share - a.share, half = Math.hypot((a.share_high - a.share_low) / 2, (b.share_high - b.share_low) / 2);
          m.set(c.hero_id, { v: g, lo: g - half, hi: g + half, n: b.n });
        }
      }
      return m;
    });
    const ids = [...per[0].keys()].filter((id) => per[1].has(id) && per[2].has(id));
    return ids.map((id) => {
      const g = per.map((m) => m.get(id)!);
      return { hero_id: id, v: g.map((x) => x.v) as RankRow["v"], ci: g.map((x) => [x.lo, x.hi]) as RankRow["ci"], n: g.map((x) => x.n) as RankRow["n"] };
    }).sort((a, b) => (b.v[2] - b.v[0]) - (a.v[2] - a.v[0]));
  }, [measure, from, to, ...idx.map((r) => r.data), ...am.map((r) => r.data)]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (v: number) => measure === "length" ? `${signed(v)} pp` : `${signed(v)} pts`;
  const r = rows.length > 3 ? corr(rows.map((x) => x.v[0]), rows.map((x) => x.v[2])) : null;
  const name = (id: number) => byId.get(id)?.name ?? `Hero ${id}`;
  // differences bigger than both brackets' intervals allow (a rough screen, not a formal test)
  const clear = rows.filter((x) => {
    const half = Math.hypot((x.ci[0][1] - x.ci[0][0]) / 2, (x.ci[2][1] - x.ci[2][0]) / 2);
    return Math.abs(x.v[2] - x.v[0]) > half;
  });

  return (
    <>
      <p className="muted small" style={{ margin: "0 0 12px", maxWidth: "80ch" }}>
        Does skill change who scales? Ranked matches only, split into three rank brackets.{" "}
        {measure === "length"
          ? "Each mark is the hero's scaling index (win rate per extra 10 minutes of game, adjusted for hero strength) in that bracket."
          : `Each mark is how much the hero's share of the souls grows from minute ${from} to ${to} in that bracket.`}{" "}
        Heroes are sorted by the difference between high and low ranks.
      </p>
      <div className="filters" role="group" aria-label="Filters">
        <div className="filter">
          <label htmlFor="rc-patch">Patch</label>
          <select id="rc-patch" value={slice.period} onChange={(e) => update({ period: e.target.value })} disabled={(meta?.filters.period.length ?? 0) < 2}>
            {(meta?.filters.period ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div className="filter">
          <span className="label-like">Measure</span>
          <div className="seg" role="group" aria-label="Measure">
            <button aria-pressed={measure === "length"} onClick={() => setMeasure("length")}>Win rate by game length</button>
            <button aria-pressed={measure === "minute"} onClick={() => setMeasure("minute")}>Souls growth {from}→{to} min</button>
          </div>
        </div>
        <div className="sample">
          {RANKS.map((rk, k) => {
            const n = meta?.sample_sizes[`ranked|${rk}|${slice.period}`]?.matches;
            return <span key={rk}>{BRACKETS[k]}: <b className="num">{n != null ? int(n) : "–"}</b><br /></span>;
          })}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <Loading loading={loading}>
        {rows.length > 0 && (
          <div className="tiles">
            <div className="tile card">
              <div className="label">Low vs high ranks agree?</div>
              <div className="value">{r != null ? `r = ${r.toFixed(2)}` : "–"}</div>
              <div className="sub">correlation across {rows.length} heroes; 1 = the same order in both</div>
            </div>
            <div className="tile card">
              <div className="label">More late-game at high ranks</div>
              {rows.slice(0, 3).map((x) => <div key={x.hero_id} className="sub"><Link to={`/heroes/${x.hero_id}${search}`}>{name(x.hero_id)}</Link> {fmt(x.v[2] - x.v[0])}</div>)}
            </div>
            <div className="tile card">
              <div className="label">More early-game at high ranks</div>
              {rows.slice(-3).reverse().map((x) => <div key={x.hero_id} className="sub"><Link to={`/heroes/${x.hero_id}${search}`}>{name(x.hero_id)}</Link> {fmt(x.v[2] - x.v[0])}</div>)}
            </div>
            <div className="tile card">
              <div className="label">Clear differences</div>
              <div className="value">{clear.length} of {rows.length}</div>
              <div className="sub">heroes whose high–low gap is bigger than the two brackets' intervals combined</div>
            </div>
          </div>
        )}
        <div className="card">
          <div className="card-head">
            <RankLegend />
            <ViewToggle value={view} onChange={setView} />
          </div>
          {view === "chart" ? (
            <RankDots rows={rows} heroes={byId} fmt={fmt} linkSearch={search} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Hero</th>{BRACKETS.map((b) => <th key={b}>{b}</th>)}<th>High − low</th><th>Games (high)</th></tr></thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={x.hero_id}>
                      <td><Link to={`/heroes/${x.hero_id}${search}`}>{name(x.hero_id)}</Link></td>
                      {x.v.map((v, k) => <td key={k}>{fmt(v)} <span className="muted small">({signed(x.ci[k][0])} to {signed(x.ci[k][1])})</span></td>)}
                      <td>{fmt(x.v[2] - x.v[0])}</td><td>{int(x.n[2])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Loading>
      <p className="muted small" style={{ marginTop: 10, maxWidth: "80ch" }}>
        High ranks have fewer games, so their intervals are wider (hover a hero for all three). Matches where someone left
        are not counted. The "clear differences" count is a rough screen: with {rows.length || 40}+ heroes, a couple will
        cross it by chance.
      </p>
    </>
  );
}
