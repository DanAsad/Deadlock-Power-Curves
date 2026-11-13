// One hero's value at each game minute (pipeline/at_minute.py), with a 95% CI
// band and a zero line = the average hero. Same reading as the power curve:
// line + band + markers, crosshair tooltip that snaps to the nearest minute.
import { useState } from "react";
import { int } from "../format";
import { useWidth } from "../components/ui";
import { linear, niceStep, ticks } from "./scale";

export interface MinutePoint { minute: number; n: number; value: number; low: number; high: number; enough: boolean }

const X_DOMAIN: [number, number] = [3, 45];
const X_TICKS = [3, 10, 15, 20, 30, 40, 45];
const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;

export function AtMinute({ points, label, describe, height = 260, color = "var(--series)" }: {
  points: MinutePoint[]; label: string; describe: (p: MinutePoint) => string; height?: number; color?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const shown = points.filter((p) => p.enough).sort((a, b) => a.minute - b.minute);
  const m = { l: 48, r: 14, t: 12, b: 30 };
  const W = Math.max(width, 200), H = height;
  const ext = Math.max(0.5, ...shown.flatMap((p) => [Math.abs(p.low), Math.abs(p.high)])) * 1.1;   // symmetric around 0
  const x = linear(X_DOMAIN, [m.l, W - m.r]);
  const y = linear([-ext, ext], [H - m.b, m.t]);
  const step = niceStep(2 * ext, 4);
  const yt = ticks(-ext, ext, step);
  const line = shown.map((p, i) => `${i ? "L" : "M"}${x(p.minute)},${y(p.value)}`).join("");
  const band = shown.map((p, i) => `${i ? "L" : "M"}${x(p.minute)},${y(p.high)}`).join("") +
    [...shown].reverse().map((p) => `L${x(p.minute)},${y(p.low)}`).join("") + (shown.length ? "Z" : "");
  const nearest = (px: number) => shown.reduce((b, p, i) => (Math.abs(x(p.minute) - px) < Math.abs(x(shown[b].minute) - px) ? i : b), 0);
  const a = active != null ? shown[active] : null;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" aria-label={`${label}, at ${shown.length} game minutes`} tabIndex={shown.length ? 0 : -1}
          onPointerMove={(e) => shown.length && setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((v) => v ?? 0)} onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (!shown.length) return;
            if (e.key === "ArrowRight") setActive((v) => Math.min((v ?? -1) + 1, shown.length - 1));
            else if (e.key === "ArrowLeft") setActive((v) => Math.max((v ?? 1) - 1, 0));
            else return;
            e.preventDefault();
          }}>
          <g className="axis">
            {yt.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} shapeRendering="crispEdges"
                      stroke={Math.abs(t) < 1e-9 ? "var(--axis)" : "var(--grid)"} strokeWidth={Math.abs(t) < 1e-9 ? 1.5 : 1} />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{t === 0 ? "avg" : signed(t, step < 1 ? 1 : 0)}</text>
              </g>
            ))}
            {X_TICKS.map((t) => <text key={t} x={x(t)} y={H - m.b + 16} textAnchor="middle">{t}m</text>)}
            {W >= 420 && <text x={W - m.r} y={H - 2} textAnchor="end">game minute</text>}
          </g>
          <path d={band} fill="var(--band)" />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {a && <line x1={x(a.minute)} x2={x(a.minute)} y1={m.t} y2={H - m.b} stroke="var(--axis)" />}
          {shown.map((p, i) => (
            <circle key={p.minute} cx={x(p.minute)} cy={y(p.value)} r={i === active ? 5.5 : 4}
                    fill={color} stroke="var(--surface)" strokeWidth={2} />
          ))}
          {!shown.length && <text x={W / 2} y={H / 2} textAnchor="middle" className="tick">Not enough games</text>}
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: x(a.minute), top: y(a.value) }}>
          <div className="tv">{signed(a.value, 2)}</div>
          <div className="tl">{describe(a)}</div>
          <div className="tl">95% CI {signed(a.low, 2)} to {signed(a.high, 2)}</div>
          <div className="tl">{int(a.n)} games still running at {a.minute} min</div>
        </div>
      )}
    </div>
  );
}
