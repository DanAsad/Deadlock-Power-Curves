export function linear([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** A 1/2/5 x 10^n step giving about `target` ticks across `span`. */
export function niceStep(span: number, target = 5): number {
  const raw = span / Math.max(target, 1);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

export function ticks(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t / step) * step);
  return out;
}
