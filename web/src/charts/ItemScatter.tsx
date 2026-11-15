// Each item twice over: x = its buyers' raw win-rate edge (win rate − 50%), y = the edge left
// after comparing with the same hero in the same game state. The dashed diagonal is "no
// adjustment"; points far below it got most of their raw edge from being bought by the side
// that was already ahead. Slot = colour and shape (never colour alone).
import { useState } from "react";
import { useWidth } from "../components/ui";
import { linear, niceStep, ticks } from "./scale";

export interface ItemPoint { id: number; name: string; slot: string; raw: number; effect: number; n: number; selected?: boolean }

export const SLOT_STYLE: Record<string, { color: string; label: string }> = {
  weapon: { color: "var(--cat-2)", label: "Weapon" },
  vitality: { color: "var(--cat-3)", label: "Vitality" },
  spirit: { color: "var(--series)", label: "Spirit" },
};
const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

export function SlotMark({ slot, x, y, r = 5, stroke = "var(--surface)" }: { slot: string; x: number; y: number; r?: number; stroke?: string }) {
  const c = SLOT_STYLE[slot]?.color ?? "var(--ink-2)";
  if (slot === "vitality") return <rect x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} rx={1.5} fill={c} stroke={stroke} strokeWidth={1.5} />;
  if (slot === "spirit") return <path d={`M${x},${y - r * 1.2}L${x + r * 1.2},${y}L${x},${y + r * 1.2}L${x - r * 1.2},${y}Z`} fill={c} stroke={stroke} strokeWidth={1.5} />;
  return <circle cx={x} cy={y} r={r} fill={c} stroke={stroke} strokeWidth={1.5} />;
}

export function ItemScatter({ points, onSelect, height = 380 }: { points: ItemPoint[]; onSelect?: (id: number) => void; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const W = Math.max(width, 300), H = height;
  const m = { l: 48, r: 16, t: 14, b: 40 };
  if (!points.length) return <div className="chart" ref={ref} style={{ height: H }} />;
  const all = points.flatMap((p) => [p.raw, p.effect]);
  const lo = Math.min(-1, ...all), hi = Math.max(1, ...all);
  const pad = (hi - lo) * 0.06;
  const x = linear([lo - pad, hi + pad], [m.l, W - m.r]);
  const y = linear([lo - pad, hi + pad], [H - m.b, m.t]);
  const step = niceStep(hi - lo, 6);
  const tk = ticks(lo - pad, hi + pad, step);
  const a = active != null ? points[active] : null;
  const nearest = (px: number, py: number) => points.reduce((b, p, i) =>
    (Math.hypot(x(p.raw) - px, y(p.effect) - py) < Math.hypot(x(points[b].raw) - px, y(points[b].effect) - py) ? i : b), 0);

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg width={W} height={H} role="img" aria-label="Raw versus adjusted win-rate edge for each item"
          onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setActive(nearest(e.clientX - r.left, e.clientY - r.top)); }}
          onPointerLeave={() => setActive(null)}
          onClick={() => a && onSelect?.(a.id)}>
          <g className="axis">
            {tk.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} shapeRendering="crispEdges" />
                <line x1={x(t)} x2={x(t)} y1={m.t} y2={H - m.b} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} shapeRendering="crispEdges" />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{signed(t, 0)}</text>
                <text x={x(t)} y={H - m.b + 16} textAnchor="middle">{signed(t, 0)}</text>
              </g>
            ))}
            <text x={W - m.r} y={H - 4} textAnchor="end">raw: buyers' win rate − 50% (pp)</text>
            <text x={m.l + 4} y={m.t + 10}>adjusted effect (pp)</text>
          </g>
          <line x1={x(lo - pad)} y1={y(lo - pad)} x2={x(hi + pad)} y2={y(hi + pad)} stroke="var(--muted)" strokeDasharray="5 5" />
          <text x={x(hi) - 4} y={y(hi) + 16} textAnchor="end" fontSize={11} fill="var(--muted)">no adjustment</text>
          {points.map((p, i) => (
            <g key={p.id} opacity={active == null || active === i ? 1 : 0.55}>
              <SlotMark slot={p.slot} x={x(p.raw)} y={y(p.effect)} r={p.selected ? 7 : 4.5} stroke={p.selected ? "var(--ink)" : "var(--surface)"} />
            </g>
          ))}
          {a && <circle cx={x(a.raw)} cy={y(a.effect)} r={9} fill="none" stroke="var(--ink)" strokeWidth={1.5} />}
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(a.raw), 120), W - 120), top: y(a.effect), transform: y(a.effect) < 120 ? "translate(-50%, 16px)" : undefined }}>
          <div className="tv">{a.name}</div>
          <div className="tl">raw {signed(a.raw)} pp → adjusted {signed(a.effect)} pp</div>
          <div className="tl">{a.n.toLocaleString("en-US")} purchases · click for details</div>
        </div>
      )}
    </div>
  );
}

export function SlotLegend() {
  return (
    <div className="legend" style={{ alignItems: "center" }}>
      {Object.entries(SLOT_STYLE).map(([k, v]) => (
        <span key={k}><svg width={14} height={14} style={{ marginRight: 6, verticalAlign: -2 }}><SlotMark slot={k} x={7} y={7} r={5} /></svg>{v.label}</span>
      ))}
      <span><i className="ln" style={{ background: "var(--muted)" }} />no adjustment (raw = adjusted)</span>
    </div>
  );
}
