// One row per hero, one mark per rank bracket on a shared axis: hollow = low ranks,
// small = middle, filled = high ranks, joined by a line from low to high. Rows are sorted
// by the high-minus-low difference, so the heroes rank changes most sit at the ends.
// Marks differ in shape as well as position, so the brackets never rely on colour.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Hero } from "../api";
import { useWidth } from "../components/ui";
import { linear } from "./scale";

export interface RankRow {
  hero_id: number;
  v: [number, number, number];                    // low, mid, high
  ci: [[number, number], [number, number], [number, number]];
  n: [number, number, number];
}

const ROW = 22, TOP = 26;
export const BRACKETS = ["Initiate–Arcanist", "Ritualist–Archon", "Oracle–Eternus"];

export function RankDots({ rows, heroes, fmt, linkSearch }: {
  rows: RankRow[]; heroes: Map<number, Hero>; fmt: (v: number) => string; linkSearch: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const navigate = useNavigate();
  const W = Math.max(width, 300);
  const LABEL = W < 560 ? 92 : 130;
  const vals = rows.flatMap((r) => r.v);
  const ext = Math.max(1, ...vals.map(Math.abs)) * 1.1;
  const x = linear([-ext, ext], [LABEL + 8, W - 16]);
  const H = TOP + rows.length * ROW + 8;
  const ticks = [-ext, -ext / 2, 0, ext / 2, ext].map((t) => Math.round(t * 2) / 2);
  const a = active != null ? rows[active] : null;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" aria-label="Value by rank bracket for each hero">
          <g className="axis">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={TOP - 6} y2={H - 6} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} shapeRendering="crispEdges" />
                <text x={x(t)} y={TOP - 12} textAnchor="middle">{fmt(t)}</text>
              </g>
            ))}
          </g>
          {rows.map((r, i) => {
            const y = TOP + i * ROW + ROW / 2;
            const h = heroes.get(r.hero_id);
            const up = r.v[2] >= r.v[0];
            return (
              <g key={r.hero_id} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}
                 onClick={() => navigate(`/heroes/${r.hero_id}${linkSearch}`)} style={{ cursor: "pointer" }}>
                <rect x={0} y={y - ROW / 2} width={W} height={ROW} fill={active === i ? "var(--surface-2)" : "transparent"} />
                <text x={LABEL - 4} y={y} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--ink-2)">{h?.name ?? r.hero_id}</text>
                <line x1={x(r.v[0])} x2={x(r.v[2])} y1={y} y2={y} stroke={up ? "var(--series)" : "var(--early)"} strokeWidth={2} />
                <circle cx={x(r.v[0])} cy={y} r={4.5} fill="var(--surface)" stroke="var(--ink-2)" strokeWidth={1.5} />
                <rect x={x(r.v[1]) - 1.5} y={y - 5} width={3} height={10} rx={1} fill="var(--ink-2)" />
                <circle cx={x(r.v[2])} cy={y} r={5} fill={up ? "var(--series)" : "var(--early)"} stroke="var(--surface)" strokeWidth={1.5} />
              </g>
            );
          })}
        </svg>
      )}
      {a && active != null && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(a.v[2]), 140), W - 140), top: TOP + active * ROW + ROW, transform: "translate(-50%, 6px)" }}>
          <div className="tv">{heroes.get(a.hero_id)?.name}</div>
          {BRACKETS.map((b, k) => (
            <div key={b} className="tl">{b}: <b className="num">{fmt(a.v[k])}</b> (95% CI {fmt(a.ci[k][0])} to {fmt(a.ci[k][1])}; {a.n[k].toLocaleString("en-US")} games)</div>
          ))}
          <div className="tl" style={{ marginTop: 2 }}>high minus low: <b className="num">{fmt(a.v[2] - a.v[0])}</b></div>
        </div>
      )}
    </div>
  );
}

export function RankLegend() {
  return (
    <div className="legend" style={{ alignItems: "center" }}>
      <span><svg width={12} height={12} style={{ marginRight: 6, verticalAlign: -1 }}><circle cx={6} cy={6} r={4.5} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} /></svg>{BRACKETS[0]}</span>
      <span><svg width={8} height={12} style={{ marginRight: 6, verticalAlign: -1 }}><rect x={2.5} y={1} width={3} height={10} rx={1} fill="var(--ink-2)" /></svg>{BRACKETS[1]}</span>
      <span><svg width={12} height={12} style={{ marginRight: 6, verticalAlign: -1 }}><circle cx={6} cy={6} r={5} fill="var(--ink-2)" /></svg>{BRACKETS[2]}</span>
      <span><i className="ln" style={{ background: "var(--series)" }} />Higher at high ranks</span>
      <span><i className="ln" style={{ background: "var(--early)" }} />Lower at high ranks</span>
    </div>
  );
}
