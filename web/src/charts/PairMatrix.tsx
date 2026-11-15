// Every hero pair at once: rows = hero, columns = the other hero, colour = effect in
// percentage points on a diverging scale (red below expected <- grey 0 -> blue above).
// Pairs under the minimum-games threshold are left empty. Hover for numbers; click to
// select a pair; arrow keys move a focus cursor.
import { useState } from "react";
import type { Hero } from "../api";
import { useWidth } from "../components/ui";
import { int, pct } from "../format";

export interface PairCell { n: number; win_rate: number; expected: number; effect: number; ci_low: number; ci_high: number }

interface Props {
  heroes: Hero[];                                   // row/column order
  cell: (a: number, b: number) => PairCell | undefined;
  kind: "with" | "against";
  selected: [number, number] | null;
  onSelect: (a: number, b: number) => void;
  extent?: number;                                  // effect (pp) at full colour
}

const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const fill = (v: number, ext: number) => {
  const s = Math.min(Math.abs(v) / ext, 1);
  return `color-mix(in oklab, ${v >= 0 ? "var(--series)" : "var(--early)"} ${Math.round(s * 100)}%, var(--div-mid))`;
};

export function PairMatrix({ heroes, cell, kind, selected, onSelect, extent = 3 }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<[number, number] | null>(null);
  const N = heroes.length;
  const W0 = Math.max(width, 300);
  const IMG = W0 < 700 ? 0 : 18;
  const LABEL_W = W0 < 700 ? 74 : 112;
  const TOP = W0 < 700 ? 74 : 92;
  const size = Math.max(12, Math.min(22, Math.floor((W0 - LABEL_W - 8) / Math.max(N, 1))));
  const W = Math.max(W0, LABEL_W + N * size + 8);
  const H = TOP + N * size + 4;
  const a = active;
  const c = a ? cell(heroes[a[0]].id, heroes[a[1]].id) : undefined;
  const verb = kind === "with" ? "with" : "against";

  const move = (di: number, dj: number) =>
    setActive((cur) => {
      const [i, j] = cur ?? [0, 1];
      return [Math.min(Math.max(i + di, 0), N - 1), Math.min(Math.max(j + dj, 0), N - 1)];
    });

  return (
    <div className="chart" ref={ref} style={{ height: H + 8, overflowX: "auto", overflowY: "hidden" }}>
      {width > 0 && (
        <svg width={W} height={H} role="grid" tabIndex={0}
          aria-label={`Hero pair effects, ${kind === "with" ? "same team" : "opposite teams"}; arrow keys move, Enter selects`}
          onFocus={() => setActive((v) => v ?? [0, 1])} onBlur={() => setActive(null)} onPointerLeave={() => setActive(null)}
          onKeyDown={(e) => {
            const k: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
            if (e.key === "Enter" && a) { onSelect(heroes[a[0]].id, heroes[a[1]].id); return; }
            if (!k[e.key]) return;
            e.preventDefault(); move(...k[e.key]);
          }}>
          {heroes.map((h, i) => {
            const on = (a && a[0] === i) || (selected && selected[0] === h.id);
            return (
              <g key={`r${h.id}`}>
                {IMG > 0 && h.image && <image href={h.image} x={LABEL_W - IMG - 4} y={TOP + i * size + (size - IMG) / 2} width={IMG} height={IMG} />}
                <text x={LABEL_W - IMG - 8} y={TOP + i * size + size / 2} dy="0.32em" textAnchor="end" fontSize={11}
                      fill={on ? "var(--ink)" : "var(--ink-2)"} fontWeight={on ? 600 : 400}>{h.name}</text>
              </g>
            );
          })}
          {heroes.map((h, j) => {
            const on = (a && a[1] === j) || (selected && selected[1] === h.id);
            return (
              <text key={`c${h.id}`} fontSize={11} fill={on ? "var(--ink)" : "var(--ink-2)"} fontWeight={on ? 600 : 400}
                    transform={`translate(${LABEL_W + j * size + size / 2 + 3},${TOP - 6}) rotate(-60)`}>{h.name}</text>
            );
          })}
          {heroes.map((h, i) => heroes.map((o, j) => {
            const v = i === j ? undefined : cell(h.id, o.id);
            const x = LABEL_W + j * size, y = TOP + i * size;
            const on = a && a[0] === i && a[1] === j;
            const sel = selected && selected[0] === h.id && selected[1] === o.id;
            return (
              <rect key={`${h.id}-${o.id}`} x={x + 1} y={y + 1} width={size - 2} height={size - 2} rx={2}
                    fill={i === j ? "var(--surface-2)" : v ? fill(v.effect, extent) : "transparent"}
                    stroke={on || sel ? "var(--ink)" : !v && i !== j ? "var(--grid)" : "none"} strokeWidth={on || sel ? 1.5 : 1}
                    style={{ cursor: v ? "pointer" : "default" }}
                    onPointerEnter={() => setActive([i, j])}
                    onClick={() => v && onSelect(h.id, o.id)} />
            );
          }))}
        </svg>
      )}
      {a && (
        <div className="tooltip" style={{ left: LABEL_W + a[1] * size + size / 2, top: TOP + a[0] * size, ...(a[0] < 4 ? { transform: "translate(-50%, 28px)" } : {}) }}>
          {a[0] === a[1] ? (
            <div className="tl">{heroes[a[0]].name}</div>
          ) : c ? (
            <>
              <div className="tv">{signed(c.effect)} pp</div>
              <div className="tl">{heroes[a[0]].name} {verb} {heroes[a[1]].name}</div>
              <div className="tl">won {pct(c.win_rate)}, expected {pct(c.expected)}</div>
              <div className="tl">95% CI {signed(c.ci_low)} to {signed(c.ci_high)} · {int(c.n)} games</div>
            </>
          ) : (
            <>
              <div className="tl">{heroes[a[0]].name} {verb} {heroes[a[1]].name}</div>
              <div className="tl">too few games</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function PairLegend({ extent = 3 }: { extent?: number }) {
  const steps = [-1, -0.5, 0, 0.5, 1];
  return (
    <div className="legend" style={{ alignItems: "center" }}>
      <span>Below expected</span>
      {steps.map((s) => (
        <span key={s} title={`${signed(s * extent)} pp`}><i className="sw" style={{ background: fill(s * extent, extent), marginRight: 2 }} />{s === 0 ? "0" : s === -1 ? `≤ −${extent}` : s === 1 ? `≥ +${extent}` : ""}</span>
      ))}
      <span>Above expected (pp)</span>
      <span><i className="sw" style={{ background: "transparent", outline: "1px solid var(--grid)" }} />too few games</span>
    </div>
  );
}
