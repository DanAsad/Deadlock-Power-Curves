// Reliability diagram: predicted win probability vs observed win rate on
// held-out matches, with 95% Wilson CIs. The diagonal is perfect calibration.
import { useState } from "react";
import type { CalibrationBin } from "../api";
import { useWidth } from "../components/ui";
import { int, pct } from "../format";
import { linear } from "./scale";

export function Calibration({ bins, height = 300 }: { bins: CalibrationBin[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const m = { l: 44, r: 12, t: 10, b: 34 };
  const W = Math.max(width, 200), H = height;
  const x = linear([0, 1], [m.l, W - m.r]);
  const y = linear([0, 1], [H - m.b, m.t]);
  const t5 = [0, 0.25, 0.5, 0.75, 1];
  const a = active != null ? bins[active] : null;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="list" aria-label="Calibration on held-out matches">
          <g className="axis">
            {t5.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" shapeRendering="crispEdges" />
                <line x1={x(t)} x2={x(t)} y1={m.t} y2={H - m.b} stroke="var(--grid)" shapeRendering="crispEdges" />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{pct(t, 0)}</text>
                <text x={x(t)} y={H - m.b + 15} textAnchor="middle">{pct(t, 0)}</text>
              </g>
            ))}
            <text x={W - m.r} y={H - 2} textAnchor="end">predicted win probability</text>
          </g>
          <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--axis)" strokeWidth={1} />
          <path d={bins.map((b, i) => `${i ? "L" : "M"}${x(b.mean_pred)},${y(b.observed)}`).join("")}
                fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" />
          {bins.map((b, i) => (
            <g key={b.bin} role="listitem" tabIndex={0}
               aria-label={`predicted ${pct(b.mean_pred)}, observed ${pct(b.observed)}, ${int(b.n)} snapshots`}
               onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}
               onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
              <line x1={x(b.mean_pred)} x2={x(b.mean_pred)} y1={y(b.ci_low)} y2={y(b.ci_high)} stroke="var(--ink-2)" />
              <circle cx={x(b.mean_pred)} cy={y(b.observed)} r={12} fill="transparent" />
              <circle cx={x(b.mean_pred)} cy={y(b.observed)} r={i === active ? 5.5 : 4}
                      fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          ))}
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: x(a.mean_pred), top: y(a.observed) }}>
          <div className="tv">{pct(a.observed)} won</div>
          <div className="tl">predicted {pct(a.mean_pred)}</div>
          <div className="tl">95% CI {pct(a.ci_low)} – {pct(a.ci_high)}</div>
          <div className="tl">{int(a.n)} held-out snapshots</div>
        </div>
      )}
    </div>
  );
}
