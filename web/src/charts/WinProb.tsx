// Win chance over game time for one match, on one shared time axis:
//   1. the line: team 0's win chance (50% midline; the area is tinted by the team ahead)
//   2. an events strip: objectives and Mid-Boss, one row per team
//   3. kills per minute, team 0 up and team 1 down
// One crosshair spans all three; the tooltip lists everything at that minute.
import { useId, useState } from "react";
import { useWidth } from "../components/ui";
import { linear } from "./scale";

export interface WpPoint { minute: number; p: number; p_live: number; souls: number; kills0: number; kills1: number }
export interface WpEvent { t: number; kind: string; label: string; by: number }

interface Props {
  points: WpPoint[]; events: WpEvent[]; durationS: number; winner: number;
  teams: [string, string]; showLive: boolean;
}

export const TEAM_COLOR = ["var(--cat-2)", "var(--series)"];
// one letter per event kind, so a marker never relies on colour alone
export const EVENT_LETTER: Record<string, string> = {
  guardian: "G", walker: "W", base_guardian: "B", shrine: "S", patron: "P", mid_boss: "M",
};
const pc = (v: number) => `${Math.round(v * 100)}%`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString()}`;

export function WinProb({ points, events, durationS, winner, teams, showLive }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const clip = useId().replace(/:/g, "");
  const W = Math.max(width, 300);
  const m = { l: 44, r: 16, t: 22 };
  const plotH = 250, laneH = 20, killH = 54, gap = 14;

  const endMin = durationS / 60;
  const maxX = Math.max(endMin, points.length ? points[points.length - 1].minute : 1);
  const x = linear([0, maxX], [m.l, W - m.r]);
  const y = linear([0, 1], [m.t + plotH, m.t]);
  const mid = y(0.5);

  // events: one row per team, markers that would overlap move to a second or third lane
  const lanes: number[][] = [[], []];
  const placed = events.map((e) => {
    const px = x(e.t / 60);
    const row = lanes[e.by];
    let lane = row.findIndex((last) => px - last >= 18);
    if (lane < 0) { lane = row.length; row.push(px); } else row[lane] = px;
    return { ...e, px, lane };
  });
  const rows = [Math.max(lanes[0].length, 1), Math.max(lanes[1].length, 1)];
  const ev0 = m.t + plotH + 30;                               // top of team 0's event row
  const ev1 = ev0 + rows[0] * laneH + 4;
  const killTop = ev1 + rows[1] * laneH + gap + 12;
  const killMid = killTop + killH / 2;
  const H = killTop + killH + 26;

  const maxK = Math.max(1, ...points.map((p) => Math.max(p.kills0, p.kills1)));
  const kScale = (killH / 2 - 2) / maxK;
  const step = points.length > 1 ? x(points[1].minute) - x(points[0].minute) : 10;
  const barW = Math.max(2, Math.min(8, step - 2));

  const line = (key: "p" | "p_live") => points.map((p, i) => `${i ? "L" : "M"}${x(p.minute)},${y(p[key])}`).join("");
  const area = points.length
    ? `${line("p")}L${x(points[points.length - 1].minute)},${mid}L${x(points[0].minute)},${mid}Z` : "";
  const xt: number[] = [];
  for (let t = 0; t <= maxX; t += maxX > 30 ? 10 : 5) xt.push(t);

  const a = active != null ? points[active] : null;
  const nearest = (px: number) => points.reduce((b, p, i) => (Math.abs(x(p.minute) - px) < Math.abs(x(points[b].minute) - px) ? i : b), 0);
  const here = a ? events.filter((e) => Math.ceil(e.t / 60) === a.minute || (a.minute === 1 && e.t < 60)) : [];

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" tabIndex={0}
          aria-label={`Win chance of ${teams[0]} by game minute; ${teams[winner]} won`}
          onPointerMove={(e) => setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((v) => v ?? 0)} onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setActive((v) => Math.min((v ?? -1) + 1, points.length - 1));
            else if (e.key === "ArrowLeft") setActive((v) => Math.max((v ?? 1) - 1, 0));
            else return;
            e.preventDefault();
          }}>
          <defs>
            <clipPath id={`${clip}a`}><rect x={0} y={m.t} width={W} height={mid - m.t} /></clipPath>
            <clipPath id={`${clip}b`}><rect x={0} y={mid} width={W} height={m.t + plotH - mid} /></clipPath>
          </defs>

          {/* axes and grid */}
          <g className="axis">
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 0.5 ? "var(--axis)" : "var(--grid)"}
                      strokeWidth={t === 0.5 ? 1.5 : 1} shapeRendering="crispEdges" />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{pc(t)}</text>
              </g>
            ))}
            {xt.map((t) => <text key={t} x={x(t)} y={m.t + plotH + 16} textAnchor="middle">{t}m</text>)}
            <text x={m.l + 6} y={m.t + 12} fill="var(--muted)">↑ {teams[0]} favoured</text>
            <text x={m.l + 6} y={m.t + plotH - 6} fill="var(--muted)">↓ {teams[1]} favoured</text>
          </g>

          {/* game end */}
          <line x1={x(endMin)} x2={x(endMin)} y1={m.t - 6} y2={m.t + plotH} stroke="var(--axis)" strokeDasharray="3 3" />
          <text x={x(endMin)} y={m.t - 10} textAnchor="end" fontSize={11} fill="var(--ink-2)">
            {teams[winner]} win at {clock(durationS)}
          </text>

          {/* the team ahead tints the area between the line and 50% */}
          <path d={area} fill={TEAM_COLOR[0]} opacity={0.2} clipPath={`url(#${clip}a)`} />
          <path d={area} fill={TEAM_COLOR[1]} opacity={0.2} clipPath={`url(#${clip}b)`} />
          {showLive && <path d={line("p_live")} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 3" />}
          <path d={line("p")} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* crosshair through all three panels */}
          {a && <line x1={x(a.minute)} x2={x(a.minute)} y1={m.t} y2={killTop + killH} stroke="var(--axis)" />}
          {a && <circle cx={x(a.minute)} cy={y(a.p)} r={5} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />}

          {/* events strip */}
          {[0, 1].map((team) => (
            <text key={team} x={m.l - 6} y={(team ? ev1 : ev0) + laneH / 2} dy="0.32em" textAnchor="end"
                  fontSize={11} fill="var(--muted)">{team ? "B" : "A"}</text>
          ))}
          {placed.map((e, i) => {
            const cy = (e.by ? ev1 : ev0) + e.lane * laneH + laneH / 2;
            return (
              <g key={i}>
                <circle cx={e.px} cy={cy} r={8} fill="var(--surface)" stroke={TEAM_COLOR[e.by]} strokeWidth={2} />
                <text x={e.px} y={cy} dy="0.34em" textAnchor="middle" fontSize={9.5} fontWeight={650} fill="var(--ink)">
                  {EVENT_LETTER[e.kind] ?? "•"}
                </text>
              </g>
            );
          })}

          {/* kills per minute */}
          <text x={m.l} y={killTop - 6} fontSize={11} fill="var(--muted)">Kills per minute</text>
          <line x1={m.l} x2={W - m.r} y1={killMid} y2={killMid} stroke="var(--axis)" shapeRendering="crispEdges" />
          {points.map((p) => (
            <g key={p.minute}>
              {p.kills0 > 0 && <rect x={x(p.minute) - barW / 2} width={barW} y={killMid - 1 - p.kills0 * kScale}
                                     height={p.kills0 * kScale} rx={Math.min(2, barW / 2)} fill={TEAM_COLOR[0]} />}
              {p.kills1 > 0 && <rect x={x(p.minute) - barW / 2} width={barW} y={killMid + 1}
                                     height={p.kills1 * kScale} rx={Math.min(2, barW / 2)} fill={TEAM_COLOR[1]} />}
            </g>
          ))}
          <text x={W - m.r} y={H - 4} textAnchor="end" fontSize={11} fill="var(--muted)">game minute</text>
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(a.minute), 110), W - 110), top: m.t + 4, transform: "translate(-50%, 0)" }}>
          <div className="tl" style={{ marginBottom: 2 }}>minute {a.minute}</div>
          <div><span className="key" style={{ background: TEAM_COLOR[0] }} /><b className="num">{pc(a.p)}</b> <span className="tl">{teams[0]}</span></div>
          <div><span className="key" style={{ background: TEAM_COLOR[1] }} /><b className="num">{pc(1 - a.p)}</b> <span className="tl">{teams[1]}</span></div>
          {showLive && <div><span className="key" style={{ background: "var(--muted)" }} /><b className="num">{pc(a.p_live)}</b> <span className="tl">{teams[0]}, live model</span></div>}
          <div className="tl" style={{ marginTop: 2 }}>
            soul lead <b className="num">{signed(a.souls)}</b> ({a.souls >= 0 ? teams[0] : teams[1]}) · kills {a.kills0}–{a.kills1}
          </div>
          {here.map((e, i) => (
            <div key={i} className="tl"><span className="key" style={{ background: TEAM_COLOR[e.by] }} />{clock(e.t)} {e.label} ({teams[e.by]})</div>
          ))}
        </div>
      )}
    </div>
  );
}
