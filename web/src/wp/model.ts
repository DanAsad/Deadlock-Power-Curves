// Runs the exported win model (pipeline/export_web.py) in the browser.
// Mirrors pipeline/model.py: linear score per queue -> boosted trees ->
// average with the team-flipped view -> isotonic recalibration.

export interface Table { minutes: number[]; weights: number[][] }
export interface WebModel {
  diffs: string[]; feats: string[]; context: string[]; ranked_only: string[]; mirrored: number[];
  snap_minutes: number[];
  tables: { unranked: Table; ranked: Table };
  baseline: number;
  trees: { offset: number[]; feature: number[]; threshold: number[]; left: number[]; right: number[]; value: number[]; missing_left: number[] };
  iso: { x: number[]; y: number[] };
  clip: number;
}

/** One game state: factor differences (team 0 minus team 1) plus context. Missing keys count as 0. */
export type Row = Record<string, number>;

/** numpy.interp: linear between points, clamped at both ends. */
export function interp(x: number, xs: number[], ys: number[]): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]);
}

/** Minutes since the last stats snapshot (0 at a snapshot minute). */
export function staleness(minute: number, snaps: number[]): number {
  let last = 0;
  for (const s of snaps) if (s <= minute) last = s;
  return minute - last;
}

function linearScore(m: WebModel, row: Row, ranked: boolean): number {
  const t = ranked ? m.tables.ranked : m.tables.unranked;
  let out = 0;
  m.diffs.forEach((c, j) => {
    const v = m.ranked_only.includes(c) && !ranked ? 0 : row[c] ?? 0;
    if (v !== 0) out += v * interp(row.minute, t.minutes, t.weights.map((w) => w[j]));
  });
  return out;
}

/** The model's input vector, in the order of model.feats. */
export function features(m: WebModel, row: Row): number[] {
  const ranked = (row.ranked ?? 0) === 1;
  const total = row.total_souls ?? NaN;
  const special: Row = {
    souls_rel: (row.souls ?? 0) / Math.max(total, 1),
    linear: linearScore(m, row, ranked),
    stale: row.stale ?? staleness(row.minute, m.snap_minutes),
    total_souls: total,
  };
  return m.feats.map((f) => {
    if (f in special) return special[f];
    if (m.ranked_only.includes(f) && !ranked) return 0;
    return row[f] ?? 0;
  });
}

function rawScore(m: WebModel, x: number[]): number {
  const t = m.trees;
  let s = m.baseline;
  for (let k = 0; k + 1 < t.offset.length; k++) {
    const base = t.offset[k];
    let i = base;
    while (t.feature[i] >= 0) {
      const v = x[t.feature[i]];
      const left = Number.isNaN(v) ? t.missing_left[i] === 1 : v <= t.threshold[i];
      i = base + (left ? t.left[i] : t.right[i]);
    }
    s += t.value[i];
  }
  return s;
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** P(team 0 wins) for one game state. */
export function predict(m: WebModel, row: Row): number {
  const x = features(m, row);
  const flipped = x.slice();
  for (const i of m.mirrored) flipped[i] = -flipped[i];
  const p = sigmoid(rawScore(m, x)), q = sigmoid(rawScore(m, flipped));
  const raw = clamp((p + 1 - q) / 2, m.clip, 1 - m.clip);
  return clamp(interp(raw, m.iso.x, m.iso.y), m.clip, 1 - m.clip);
}
