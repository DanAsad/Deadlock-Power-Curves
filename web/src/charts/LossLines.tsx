// A few series over game minutes on one axis (lower = better), with an optional
// labelled reference line. Crosshair snaps to the nearest minute and the
// tooltip lists every series there. Legend is rendered by the caller.
import { useState } from "react";
import { useWidth } from "../components/ui";
import { linear, niceStep, ticks } from "./scale";

export interface Series { id: string; label: string; color: string; points: { x: number; y: number }[] }

interface Props {
  series: Series[]; height?: number; format: (v: number) => string;
  reference?: { y: number; label: string }; highlightX?: number; yLabel: string;
}

export function LossLines({ series, height = 280, format, reference, highlightX, yLabel }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const m = { l: 52, r: 16, t: 12, b: 30 };
  const W = Math.max(width, 260), H = height;
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).concat(reference ? [reference.y] : []);
  if (!xs.length) return <div className="chart" ref={ref} style={{ height: H }} />;
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.08 || 0.01;
  const x = linear([0, Math.max(...xs) + 2], [m.l, W - m.r]);
  const y = linear([lo - pad, hi + pad], [H - m.b, m.t]);
  const yt = ticks(lo - pad, hi + pad, niceStep(hi - lo + 2 * pad, 5));
  const ax = active != null ? xs[active] : null;
  const nearest = (px: number) => xs.reduce((b, v, i) => (Math.abs(x(v) - px) < Math.abs(x(xs[b]) - px) ? i : b), 0);

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" tabIndex={0} aria-label={`${yLabel} by game minute`}
          onPointerMove={(e) => setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((v) => v ?? 0)} onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setActive((v) => Math.min((v ?? -1) + 1, xs.length - 1));
            else if (e.key === "ArrowLeft") setActive((v) => Math.max((v ?? 1) - 1, 0));
            else return;
            e.preventDefault();
          }}>
          <g className="axis">
            {yt.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" shapeRendering="crispEdges" />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{format(t)}</text>
              </g>
            ))}
            {[10, 20, 30, 40].filter((t) => t <= Math.max(...xs) + 2).map((t) => (
              <text key={t} x={x(t)} y={H - m.b + 16} textAnchor="middle">{t}m</text>
            ))}
            <text x={W - m.r} y={H - 2} textAnchor="end">game minute</text>
          </g>
          {highlightX != null && (
            <line x1={x(highlightX)} x2={x(highlightX)} y1={m.t} y2={H - m.b} stroke="var(--grid)" strokeWidth={8} opacity={0.6} />
          )}
          {reference && (
            <g>
              <line x1={m.l} x2={W - m.r} y1={y(reference.y)} y2={y(reference.y)} stroke="var(--axis)" strokeWidth={1.5} />
              <text x={W - m.r} y={y(reference.y) - 5} textAnchor="end" fontSize={11} fill="var(--muted)">{reference.label}</text>
            </g>
          )}
          {ax != null && <line x1={x(ax)} x2={x(ax)} y1={m.t} y2={H - m.b} stroke="var(--axis)" />}
          {series.map((s) => (
            <g key={s.id}>
              <path d={s.points.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.y)}`).join("")}
                    fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.points.map((p) => (
                <circle key={p.x} cx={x(p.x)} cy={y(p.y)} r={p.x === ax ? 5 : 3.5}
                        fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          ))}
        </svg>
      )}
      {ax != null && (
        <div className="tooltip" style={{ left: x(ax), top: m.t + 8, transform: "translate(-50%, 0)" }}>
          <div className="tl" style={{ marginBottom: 2 }}>minute {ax}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === ax);
            return p ? (
              <div key={s.id}>
                <span className="key" style={{ background: s.color }} />
                <b className="num">{format(p.y)}</b> <span className="tl">{s.label}</span>
              </div>
            ) : null;
          })}
          {reference && <div className="tl">{format(reference.y)} {reference.label}</div>}
        </div>
      )}
    </div>
  );
}
