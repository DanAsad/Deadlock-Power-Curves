// Full correlation matrix on a diverging scale:
// red (-1) <- neutral grey (0) -> blue (+1). Colours mix in OKLab from the
// theme tokens, so light and dark mode each get their own validated steps.
// The matrix is symmetric; the diagonal (a factor with itself) is left plain.
// Factors with no variation in the current slice/minute are hidden and listed
// below. Values are printed only where |r| >= 0.3 (and in the "Won" row and
// column); every cell has a tooltip, and arrow keys move a focus cursor.
import { useState } from "react";
import { useWidth } from "../components/ui";

interface Props {
  vars: string[];                       // first var is the outcome ("won")
  r: (number | null)[][];
  labels: Record<string, string>;
  n: number;                            // matches behind each correlation
}

const fill = (v: number) =>
  `color-mix(in oklab, ${v >= 0 ? "var(--series)" : "var(--early)"} ${Math.round(Math.abs(v) * 100)}%, var(--div-mid))`;

export function CorrHeatmap({ vars, r, labels, n }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<[number, number] | null>(null);

  // keep factors that correlate with at least one other factor here
  const keep = vars.map((_, i) => i).filter((i) => r[i].some((v, j) => j !== i && v != null));
  const hidden = vars.filter((_, i) => !keep.includes(i));
  const N = keep.length;

  const W0 = Math.max(width, 300);
  const narrow = W0 < 560;
  const LABEL_W = narrow ? 84 : 120;
  const BOTTOM = narrow ? 70 : 84;
  const cell = Math.max(26, Math.min(48, Math.floor((W0 - LABEL_W - 8) / Math.max(N, 1))));
  const W = Math.max(W0, LABEL_W + N * cell + 8);    // wider than the screen -> scrolls sideways
  const H = N * cell + BOTTOM;
  const showText = cell >= 30;
  const at = (i: number, j: number) => r[keep[i]][keep[j]];
  const name = (i: number) => labels[vars[keep[i]]] ?? vars[keep[i]];
  const isWon = (i: number) => vars[keep[i]] === "won";
  const a = active;
  const av = a ? at(a[0], a[1]) : null;

  const move = (di: number, dj: number) =>
    setActive((cur) => {
      const [i, j] = cur ?? [0, 0];
      return [Math.min(Math.max(i + di, 0), N - 1), Math.min(Math.max(j + dj, 0), N - 1)];
    });

  return (
    <>
      <div className="chart" ref={ref} style={{ height: H + 12, overflowX: "auto", overflowY: "hidden" }}>
        {width > 0 && (
          <svg width={W} height={H} role="grid" aria-label="Correlation between factors" tabIndex={0}
            onFocus={() => setActive((v) => v ?? [0, 1])} onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
            onKeyDown={(e) => {
              const k: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
              if (!k[e.key]) return;
              e.preventDefault(); move(...k[e.key]);
            }}>
            {keep.map((_, i) => (
              <text key={`r${i}`} x={LABEL_W - 8} y={i * cell + cell / 2} dy="0.32em" textAnchor="end" fontSize={12}
                    fill={a && a[0] === i ? "var(--ink)" : "var(--ink-2)"} fontWeight={a && a[0] === i ? 600 : 400}>
                {name(i)}
              </text>
            ))}
            {keep.map((_, j) => (
              <text key={`c${j}`} fontSize={12} textAnchor="end"
                    fill={a && a[1] === j ? "var(--ink)" : "var(--ink-2)"} fontWeight={a && a[1] === j ? 600 : 400}
                    transform={`translate(${LABEL_W + j * cell + cell / 2 + 4},${N * cell + 10}) rotate(-45)`}>
                {name(j)}
              </text>
            ))}
            {keep.map((_, i) =>
              keep.map((_, j) => {
                const v = at(i, j);
                const x = LABEL_W + j * cell, y = i * cell;
                const on = a && a[0] === i && a[1] === j;
                const diag = i === j;
                const label = !diag && v != null && showText && (Math.abs(v) >= 0.3 || isWon(i) || isWon(j));
                return (
                  <g key={`${i}-${j}`} onPointerEnter={() => setActive([i, j])}>
                    <rect x={x + 1} y={y + 1} width={cell - 2} height={cell - 2} rx={3}
                          fill={diag ? "var(--surface-2)" : v == null ? "transparent" : fill(v)}
                          stroke={on ? "var(--ink)" : !diag && v == null ? "var(--grid)" : "none"}
                          strokeWidth={on ? 1.5 : 1} />
                    {!diag && v == null && showText && (
                      <text x={x + cell / 2} y={y + cell / 2} dy="0.32em" textAnchor="middle" fontSize={11} fill="var(--muted)">–</text>
                    )}
                    {label && (
                      <text x={x + cell / 2} y={y + cell / 2} dy="0.32em" textAnchor="middle" fontSize={11}
                            className="num" fill={Math.abs(v!) > 0.75 ? "#ffffff" : "var(--ink)"}>
                        {v!.toFixed(2).replace(/^(-?)0\./, "$1.")}
                      </text>
                    )}
                  </g>
                );
              }),
            )}
          </svg>
        )}
        {a && (
          <div className="tooltip" style={a[0] < 3
            ? { left: LABEL_W + a[1] * cell + cell / 2, top: (a[0] + 1) * cell, transform: "translate(-50%, 8px)" }
            : { left: LABEL_W + a[1] * cell + cell / 2, top: a[0] * cell }}>
            {a[0] === a[1] ? (
              <>
                <div className="tv">{name(a[0])}</div>
                <div className="tl">same factor</div>
              </>
            ) : (
              <>
                <div className="tv">{av == null ? "n/a" : `r = ${av.toFixed(2)}`}</div>
                <div className="tl">{name(a[0])} × {name(a[1])}</div>
                <div className="tl">{av == null ? "no variation yet at this minute" : strength(av)}</div>
                <div className="tl">{n.toLocaleString("en-US")} matches</div>
              </>
            )}
          </div>
        )}
      </div>
      {hidden.length > 0 && (
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          Not shown (no variation at this minute or in this filter): {hidden.map((v) => labels[v] ?? v).join(", ")}
        </p>
      )}
    </>
  );
}

function strength(v: number) {
  const s = Math.abs(v);
  const word = s >= 0.9 ? "almost the same signal" : s >= 0.7 ? "strong" : s >= 0.4 ? "moderate" : s >= 0.2 ? "weak" : "little to none";
  return `${word}${s >= 0.2 && s < 0.9 ? (v > 0 ? ", move together" : ", move opposite") : ""}`;
}

export function CorrLegend() {
  return (
    <div className="legend" style={{ alignItems: "center" }}>
      <span>−1</span>
      <span style={{ display: "inline-flex", width: 180, height: 10, borderRadius: 2, overflow: "hidden" }}>
        {Array.from({ length: 40 }, (_, k) => -1 + (2 * k) / 39).map((v) => (
          <i key={v} style={{ flex: 1, background: fill(v) }} />
        ))}
      </span>
      <span>+1</span>
      <span className="muted">· blue = rise together · red = one up when the other is down · grey = unrelated</span>
    </div>
  );
}
