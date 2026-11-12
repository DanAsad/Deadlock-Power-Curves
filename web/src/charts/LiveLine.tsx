// Team 0's win chance for one live game, one point per poll, against game time.
// Same reading as the finished-match graph: 50% midline, area tinted by the team ahead.
import { useId, useState } from "react";
import { useWidth } from "../components/ui";
import { linear } from "./scale";
import { TEAM_COLOR } from "./WinProb";

export interface LivePoint { minute: number; p: number; souls: number }

const pc = (v: number) => `${Math.round(v * 100)}%`;
const clock = (min: number) => `${Math.floor(min)}:${String(Math.floor((min % 1) * 60)).padStart(2, "0")}`;

export function LiveLine({ points, teams, height = 240 }: { points: LivePoint[]; teams: [string, string]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const clip = useId().replace(/:/g, "");
  const W = Math.max(width, 280), H = height;
  const m = { l: 44, r: 16, t: 10, b: 28 };
  if (!points.length) return <div className="chart" ref={ref} style={{ height: H }} />;
  const first = points[0].minute, last = points[points.length - 1].minute;
  const x = linear([first, Math.max(last, first + 5)], [m.l, W - m.r]);      // at least a 5-minute window
  const y = linear([0, 1], [H - m.b, m.t]);
  const mid = y(0.5);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.minute)},${y(p.p)}`).join("");
  const area = `${d}L${x(last)},${mid}L${x(first)},${mid}Z`;
  const xt: number[] = [];
  for (let t = Math.ceil(first); t <= Math.max(last, first + 5); t += Math.max(1, Math.round((Math.max(last, first + 5) - first) / 6))) xt.push(t);
  const a = active != null ? points[Math.min(active, points.length - 1)] : null;
  const nearest = (px: number) => points.reduce((b, p, i) => (Math.abs(x(p.minute) - px) < Math.abs(x(points[b].minute) - px) ? i : b), 0);
  const end = points[points.length - 1];

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" tabIndex={0} aria-label={`Live win chance of ${teams[0]} by game time`}
          onPointerMove={(e) => setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((v) => v ?? points.length - 1)} onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setActive((v) => Math.min((v ?? -1) + 1, points.length - 1));
            else if (e.key === "ArrowLeft") setActive((v) => Math.max((v ?? 1) - 1, 0));
            else return;
            e.preventDefault();
          }}>
          <defs>
            <clipPath id={`${clip}a`}><rect x={0} y={m.t} width={W} height={mid - m.t} /></clipPath>
            <clipPath id={`${clip}b`}><rect x={0} y={mid} width={W} height={H - m.b - mid} /></clipPath>
          </defs>
          <g className="axis">
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 0.5 ? "var(--axis)" : "var(--grid)"}
                      strokeWidth={t === 0.5 ? 1.5 : 1} shapeRendering="crispEdges" />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{pc(t)}</text>
              </g>
            ))}
            {xt.map((t) => <text key={t} x={x(t)} y={H - m.b + 16} textAnchor="middle">{t}m</text>)}
            <text x={m.l + 6} y={m.t + 12} fill="var(--muted)">↑ {teams[0]} favoured</text>
            <text x={m.l + 6} y={H - m.b - 6} fill="var(--muted)">↓ {teams[1]} favoured</text>
          </g>
          <path d={area} fill={TEAM_COLOR[0]} opacity={0.2} clipPath={`url(#${clip}a)`} />
          <path d={area} fill={TEAM_COLOR[1]} opacity={0.2} clipPath={`url(#${clip}b)`} />
          <path d={d} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {a && <line x1={x(a.minute)} x2={x(a.minute)} y1={m.t} y2={H - m.b} stroke="var(--axis)" />}
          {/* the newest point is always marked: with one poll there is no line yet */}
          <circle cx={x((a ?? end).minute)} cy={y((a ?? end).p)} r={5} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(a.minute), 100), W - 100), top: m.t + 4, transform: "translate(-50%, 0)" }}>
          <div className="tl" style={{ marginBottom: 2 }}>about {clock(a.minute)}</div>
          <div><span className="key" style={{ background: TEAM_COLOR[0] }} /><b className="num">{pc(a.p)}</b> <span className="tl">{teams[0]}</span></div>
          <div><span className="key" style={{ background: TEAM_COLOR[1] }} /><b className="num">{pc(1 - a.p)}</b> <span className="tl">{teams[1]}</span></div>
          <div className="tl" style={{ marginTop: 2 }}>soul lead <b className="num">{Math.abs(a.souls).toLocaleString()}</b> ({a.souls >= 0 ? teams[0] : teams[1]})</div>
        </div>
      )}
    </div>
  );
}
