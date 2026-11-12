// Generic horizontal bars from a baseline (0) with 95% CI whiskers.
// One series colour; sign is carried by direction. Rows whose CI includes the
// baseline are faded. Every row has a hover/focus tooltip.
import { useState } from "react";
import { useWidth } from "../components/ui";
import { barPath } from "./ScalingBars";
import { linear, niceStep, ticks } from "./scale";

export interface EffectRow {
  id: string; label: string;
  value: number | null; lo: number | null; hi: number | null;
  tooltip: string[];               // first line is shown as the bold value
  note?: string;                   // shown instead of a bar when value is null
  faded?: boolean;                 // force the faded style (e.g. rare)
}

interface Props { rows: EffectRow[]; tick: (v: number) => string; label: string; minExtent?: number }

const ROW = 26, TOP = 22;

export function EffectBars({ rows, tick, label, minExtent = 1 }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const W = Math.max(width, 280);
  const narrow = W < 520;
  const LABEL_W = narrow ? 104 : 150;
  const H = TOP + rows.length * ROW + 8;
  const vals = rows.flatMap((r) => [r.lo ?? 0, r.hi ?? 0, r.value ?? 0]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = Math.max(hi - lo, minExtent) * 0.08;
  const x = linear([Math.min(lo, 0) - (lo < 0 ? pad : 0), Math.max(hi, minExtent) + pad], [LABEL_W + 8, W - 12]);
  const step = niceStep(Math.max(hi - lo, minExtent), narrow ? 3 : 6);
  const xt = ticks(lo < 0 ? lo - pad : 0, Math.max(hi, minExtent) + pad, step);
  const yc = (i: number) => TOP + i * ROW + ROW / 2;
  const a = active != null ? rows[active] : null;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="list" aria-label={label}>
          <g className="axis">
            {xt.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={H - 8} shapeRendering="crispEdges"
                      stroke={Math.abs(t) < 1e-9 ? "var(--axis)" : "var(--grid)"} />
                <text x={x(t)} y={TOP - 10} textAnchor="middle">{tick(t)}</text>
              </g>
            ))}
          </g>
          {rows.map((r, i) => {
            const clear = !r.faded && r.lo != null && r.hi != null && (r.lo > 0 || r.hi < 0);
            return (
              <g key={r.id} role="listitem" tabIndex={0}
                 aria-label={`${r.label}: ${r.tooltip.join(", ")}`}
                 onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}
                 onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
                <rect x={0} y={yc(i) - ROW / 2} width={W} height={ROW} rx={4}
                      fill={i === active ? "var(--surface-2)" : "transparent"} />
                <text x={0} y={yc(i)} dy="0.32em" fontSize={12} fill="var(--ink)">
                  {narrow && r.label.length > 13 ? r.label.slice(0, 12) + "…" : r.label}
                </text>
                {r.value == null ? (
                  <text x={x(0) + 6} y={yc(i)} dy="0.32em" fontSize={11} fill="var(--muted)">{r.note ?? "n/a"}</text>
                ) : (
                  <>
                    <path d={barPath(x(0), x(r.value), yc(i))} fill="var(--series)" opacity={clear ? 1 : 0.4} />
                    {r.lo != null && r.hi != null && (
                      <g stroke="var(--ink-2)" strokeWidth={1}>
                        <line x1={x(r.lo)} x2={x(r.hi)} y1={yc(i)} y2={yc(i)} />
                        <line x1={x(r.lo)} x2={x(r.lo)} y1={yc(i) - 4} y2={yc(i) + 4} />
                        <line x1={x(r.hi)} x2={x(r.hi)} y1={yc(i) - 4} y2={yc(i) + 4} />
                      </g>
                    )}
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {a && a.value != null && (
        <div className="tooltip" style={{ left: x(a.value), top: yc(active!) - 6 }}>
          <div className="tv">{a.tooltip[0]}</div>
          <div className="tl">{a.label}</div>
          {a.tooltip.slice(1).map((t) => <div key={t} className="tl">{t}</div>)}
        </div>
      )}
    </div>
  );
}
