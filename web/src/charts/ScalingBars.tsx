// Diverging horizontal bars: pp of win rate per extra 10 minutes, with 95% CI
// whiskers. Sign is encoded by direction from zero AND by colour.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Hero, IndexRow } from "../api";
import { int, pct, pp } from "../format";
import { useWidth } from "../components/ui";
import { linear, niceStep, ticks } from "./scale";

interface Props { rows: IndexRow[]; heroes: Map<number, Hero>; linkSearch: string }

const ROW = 24, BAR = 12, TOP = 22, R = 4;

/** Bar from x0 (baseline, square) to x1 (data end, 4px rounded). */
export function barPath(x0: number, x1: number, yc: number) {
  const y = yc - BAR / 2, dir = x1 >= x0 ? 1 : -1;
  const len = Math.abs(x1 - x0), r = Math.min(R, len, BAR / 2);
  if (len < 0.5) return "";
  const xe = x1 - dir * r;
  return `M${x0},${y}H${xe}A${r},${r} 0 0 ${dir > 0 ? 1 : 0} ${x1},${y + r}V${y + BAR - r}` +
         `A${r},${r} 0 0 ${dir > 0 ? 1 : 0} ${xe},${y + BAR}H${x0}Z`;
}

export function ScalingBars({ rows, heroes, linkSearch }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const nav = useNavigate();

  const W = Math.max(width, 280);
  const narrow = W < 520;
  const LABEL_W = narrow ? 100 : 132;
  const H = TOP + rows.length * ROW + 8;
  const ext = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.ci_low), Math.abs(r.ci_high)])) * 1.08;
  const plotL = LABEL_W + 8, plotR = W - 12;
  const x = linear([-ext, ext], [plotL, plotR]);
  const step = niceStep(2 * ext, narrow ? 2 : 6);
  const xt = ticks(-ext, ext, step);
  const yc = (i: number) => TOP + i * ROW + ROW / 2;
  const labelled = new Set([0, 1, 2, rows.length - 3, rows.length - 2, rows.length - 1]);
  const a = active != null ? rows[active] : null;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="list" aria-label="Scaling index by hero">
          <g className="axis">
            {xt.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={H - 8} shapeRendering="crispEdges"
                      stroke={Math.abs(t) < 1e-9 ? "var(--axis)" : "var(--grid)"} />
                <text x={x(t)} y={TOP - 10} textAnchor="middle">{t === 0 ? "0" : pp(t, step < 1 ? 1 : 0)}</text>
              </g>
            ))}
          </g>
          {rows.map((r, i) => {
            const h = heroes.get(r.hero_id);
            const name = h?.name ?? `Hero ${r.hero_id}`;
            const early = r.pp_per_10min < 0;
            const clear = r.ci_low > 0 || r.ci_high < 0;   // CI excludes zero
            const go = () => nav(`/heroes/${r.hero_id}${linkSearch}`);
            return (
              <g key={r.hero_id} role="listitem" tabIndex={0} style={{ cursor: "pointer" }}
                 aria-label={`${name}: ${pp(r.pp_per_10min)} per 10 minutes, 95% CI ${pp(r.ci_low)} to ${pp(r.ci_high)}`}
                 onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}
                 onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                 onClick={go} onKeyDown={(e) => e.key === "Enter" && go()}>
                {/* hit target: the whole row, larger than the mark */}
                <rect x={0} y={yc(i) - ROW / 2} width={W} height={ROW}
                      fill={i === active ? "var(--surface-2)" : "transparent"} rx={4} />
                {h?.image && <image href={h.image} x={0} y={yc(i) - 9} width={18} height={18} />}
                <text x={h?.image ? 24 : 0} y={yc(i)} dy="0.32em" fontSize={12} fill="var(--ink)">
                  {name.length > (narrow ? 11 : 16) ? name.slice(0, narrow ? 10 : 15) + "…" : name}
                </text>
                <path d={barPath(x(0), x(r.pp_per_10min), yc(i))} fill={early ? "var(--early)" : "var(--series)"}
                      opacity={(clear ? 1 : 0.4) * (active == null || i === active ? 1 : 0.6)} />
                <g stroke="var(--ink-2)" strokeWidth={1}>
                  <line x1={x(r.ci_low)} x2={x(r.ci_high)} y1={yc(i)} y2={yc(i)} />
                  <line x1={x(r.ci_low)} x2={x(r.ci_low)} y1={yc(i) - 4} y2={yc(i) + 4} />
                  <line x1={x(r.ci_high)} x2={x(r.ci_high)} y1={yc(i) - 4} y2={yc(i) + 4} />
                </g>
                {labelled.has(i) && !narrow && (
                  <text x={early ? x(r.ci_low) - 6 : x(r.ci_high) + 6} y={yc(i)} dy="0.32em" fontSize={11}
                        textAnchor={early ? "end" : "start"} fill="var(--ink-2)" className="num">
                    {pp(r.pp_per_10min, 1)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: x(a.pp_per_10min), top: yc(active!) - 6 }}>
          <div className="tv">{pp(a.pp_per_10min)} / 10 min</div>
          <div className="tl">{heroes.get(a.hero_id)?.name ?? `Hero ${a.hero_id}`}</div>
          <div className="tl">95% CI {pp(a.ci_low)} to {pp(a.ci_high)}</div>
          {a.raw_pp_per_10min != null && <div className="tl">Before the strength adjustment {pp(a.raw_pp_per_10min)}</div>}
          <div className="tl">Win rate {pct(a.win_rate)} · {int(a.games)} games</div>
        </div>
      )}
    </div>
  );
}
