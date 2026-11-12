// Small single-series line over game minutes with a 95% CI band and a
// crosshair tooltip that snaps to the nearest minute. Used as small multiples.
import { useState } from "react";
import { useWidth } from "../components/ui";
import { linear, niceStep, ticks } from "./scale";

export interface TrendPoint { x: number; y: number; lo: number; hi: number; lines: string[] }

interface Props {
  points: TrendPoint[]; name: string; yDomain: [number, number]; xDomain: [number, number];
  formatY: (v: number) => string; height?: number; highlightX?: number; empty?: string;
}

export function TrendSmall({ points, name, yDomain, xDomain, formatY, height = 130, highlightX, empty = "Not in play" }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const m = { l: 34, r: 6, t: 6, b: 18 };
  const W = Math.max(width, 120), H = height;
  const x = linear(xDomain, [m.l, W - m.r]);
  const y = linear(yDomain, [H - m.b, m.t]);
  const yt = ticks(yDomain[0], yDomain[1], niceStep(yDomain[1] - yDomain[0], 3));
  const xt = [10, 20, 30, 40].filter((t) => t >= xDomain[0] && t <= xDomain[1]);
  const pts = [...points].sort((a, b) => a.x - b.x);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.y)}`).join("");
  const band = pts.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.hi)}`).join("") +
    [...pts].reverse().map((p) => `L${x(p.x)},${y(p.lo)}`).join("") + "Z";
  const a = active != null ? pts[active] : null;
  const nearest = (px: number) =>
    pts.reduce((b, p, i) => (Math.abs(x(p.x) - px) < Math.abs(x(pts[b].x) - px) ? i : b), 0);

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" tabIndex={pts.length ? 0 : -1}
          aria-label={`${name} by game minute`}
          onPointerMove={(e) => pts.length && setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((v) => v ?? 0)} onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setActive((v) => Math.min((v ?? -1) + 1, pts.length - 1));
            else if (e.key === "ArrowLeft") setActive((v) => Math.max((v ?? 1) - 1, 0));
            else return;
            e.preventDefault();
          }}>
          <g className="axis">
            {yt.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} shapeRendering="crispEdges"
                      stroke={Math.abs(t) < 1e-9 ? "var(--axis)" : "var(--grid)"} />
                <text x={m.l - 5} y={y(t)} dy="0.32em" textAnchor="end">{formatY(t)}</text>
              </g>
            ))}
            {xt.map((t) => <text key={t} x={x(t)} y={H - 4} textAnchor="middle">{t}m</text>)}
          </g>
          {highlightX != null && (
            <line x1={x(highlightX)} x2={x(highlightX)} y1={m.t} y2={H - m.b} stroke="var(--grid)" strokeWidth={6} opacity={0.6} />
          )}
          {pts.length > 1 && <path d={band} fill="var(--band)" />}
          {pts.length > 1 && <path d={line} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {a && <line x1={x(a.x)} x2={x(a.x)} y1={m.t} y2={H - m.b} stroke="var(--axis)" />}
          {pts.map((p, i) => (
            <circle key={p.x} cx={x(p.x)} cy={y(p.y)} r={i === active ? 4.5 : 3.5}
                    fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
          ))}
          {!pts.length && <text x={W / 2} y={H / 2} textAnchor="middle" className="tick">{empty}</text>}
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: x(a.x), top: y(a.y) }}>
          <div className="tv">{a.lines[0]}</div>
          {a.lines.slice(1).map((l) => <div key={l} className="tl">{l}</div>)}
        </div>
      )}
    </div>
  );
}
