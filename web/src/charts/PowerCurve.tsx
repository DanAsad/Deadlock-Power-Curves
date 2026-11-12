// Win rate by game-length bucket for one hero: 95% CI band + line + markers,
// a 50% reference, and a crosshair tooltip that snaps to the nearest bucket.
import { useState } from "react";
import type { CurvePoint } from "../api";
import { int, pct } from "../format";
import { useWidth } from "../components/ui";
import { linear, niceStep, ticks } from "./scale";

interface Props {
  points: CurvePoint[];            // all buckets; only enough=true are drawn
  name: string;
  height?: number;
  yDomain?: [number, number];      // shared domain for small multiples
  compact?: boolean;
}

const X_DOMAIN: [number, number] = [15, 57.5];
const X_TICKS = [20, 30, 40, 50];

export function curveDomain(points: CurvePoint[], pad = 0.01): [number, number] {
  const shown = points.filter((p) => p.enough);
  if (!shown.length) return [0.4, 0.6];
  const lo = Math.min(0.5, ...shown.map((p) => p.ci_low)) - pad;
  const hi = Math.max(0.5, ...shown.map((p) => p.ci_high)) + pad;
  return [Math.max(0, lo), Math.min(1, hi)];
}

/** Runs of consecutive buckets, so a hidden middle bucket breaks the line. */
function runs(points: CurvePoint[]): CurvePoint[][] {
  const out: CurvePoint[][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && p.bucket_idx === last[last.length - 1].bucket_idx + 1) last.push(p);
    else out.push([p]);
  }
  return out;
}

export function PowerCurve({ points, name, height = 320, yDomain, compact = false }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const shown = points.filter((p) => p.enough).sort((a, b) => a.mid_min - b.mid_min);
  const hidden = points.length - shown.length;
  const m = compact ? { l: 32, r: 6, t: 6, b: 18 } : { l: 44, r: 16, t: 12, b: 30 };
  const W = Math.max(width, 120);
  const H = height;
  const [y0, y1] = yDomain ?? curveDomain(points);
  const x = linear(X_DOMAIN, [m.l, W - m.r]);
  const y = linear([y0, y1], [H - m.b, m.t]);
  const step = niceStep(y1 - y0, compact ? 3 : 5);
  const yTicks = ticks(y0, y1, step);

  const segs = runs(shown);
  const line = (s: CurvePoint[]) => s.map((p, i) => `${i ? "L" : "M"}${x(p.mid_min)},${y(p.win_rate)}`).join("");
  const band = (s: CurvePoint[]) =>
    s.map((p, i) => `${i ? "L" : "M"}${x(p.mid_min)},${y(p.ci_high)}`).join("") +
    [...s].reverse().map((p) => `L${x(p.mid_min)},${y(p.ci_low)}`).join("") + "Z";

  const nearest = (px: number) => {
    let best = 0;
    shown.forEach((p, i) => { if (Math.abs(x(p.mid_min) - px) < Math.abs(x(shown[best].mid_min) - px)) best = i; });
    return best;
  };
  const a = active != null ? shown[active] : null;
  const label = `${name}: win rate by game length, ${shown.length} buckets shown` +
    (hidden ? `, ${hidden} hidden for too few games` : "");

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" aria-label={label} tabIndex={shown.length ? 0 : -1}
          onPointerMove={(e) => {
            if (!shown.length) return;
            const r = e.currentTarget.getBoundingClientRect();
            setActive(nearest(e.clientX - r.left));
          }}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((v) => v ?? 0)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (!shown.length) return;
            if (e.key === "ArrowRight") setActive((v) => Math.min((v ?? -1) + 1, shown.length - 1));
            else if (e.key === "ArrowLeft") setActive((v) => Math.max((v ?? 1) - 1, 0));
            else return;
            e.preventDefault();
          }}>
          {/* grid + axes */}
          <g className="axis">
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)}
                      stroke={Math.abs(t - 0.5) < 1e-9 ? "var(--axis)" : "var(--grid)"} strokeWidth={1}
                      shapeRendering="crispEdges" />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{pct(t, step < 0.01 ? 1 : 0)}</text>
              </g>
            ))}
            {X_TICKS.map((t) => (
              <text key={t} x={x(t)} y={H - m.b + (compact ? 13 : 16)} textAnchor="middle">{t}m</text>
            ))}
            {!compact && W >= 480 && (
              <text x={W - m.r} y={H - 2} textAnchor="end">game length (minutes)</text>
            )}
          </g>

          {/* data */}
          {segs.map((s, i) => <path key={`b${i}`} d={band(s)} fill="var(--band)" />)}
          {segs.map((s, i) => (
            <path key={`l${i}`} d={line(s)} fill="none" stroke="var(--series)" strokeWidth={2}
                  strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {a && <line x1={x(a.mid_min)} x2={x(a.mid_min)} y1={m.t} y2={H - m.b} stroke="var(--axis)" strokeWidth={1} />}
          {shown.map((p, i) => (
            <circle key={p.bucket_idx} cx={x(p.mid_min)} cy={y(p.win_rate)}
                    r={i === active ? (compact ? 4.5 : 5.5) : compact ? 3.5 : 4}
                    fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
          ))}
          {!shown.length && (
            <text x={W / 2} y={H / 2} textAnchor="middle" className="tick">Not enough games</text>
          )}
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: x(a.mid_min), top: y(a.win_rate) }}>
          <div className="tv">{pct(a.win_rate)}</div>
          <div className="tl"><span className="key" style={{ background: "var(--series)" }} />
            win rate, {a.bucket} min games</div>
          <div className="tl">95% CI {pct(a.ci_low)} – {pct(a.ci_high)}</div>
          <div className="tl">{int(a.games)} games</div>
        </div>
      )}
    </div>
  );
}
