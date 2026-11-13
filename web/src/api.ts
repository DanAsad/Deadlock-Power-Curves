// Typed client for the FastAPI service (see api/routers/power_curves.py).
import { useEffect, useRef, useState } from "react";

export interface Option { id: string; label: string }
export interface Slice { queue: string; rank: string; period: string }
export interface Sample { matches: number; player_rows: number }

export interface Meta {
  generated_at: string;
  source: string;
  days: number;
  first_match: string;
  last_match: string;
  bins: { idx: number; label: string; mid_min: number }[];
  min_games_per_bin: number;
  min_bins_for_index: number;
  leaver_matches_excluded?: number; leaver_share?: number;   // matches where someone left, left out of the curves
  filters: { queue: Option[]; rank: Option[]; period: Option[] };
  sample_sizes: Record<string, Sample>;
}

export interface Hero { id: number; name: string; image: string | null; card: string | null }
export interface Interval { pp_per_10min: number; ci_low: number; ci_high: number }
export interface HeroSummary extends Hero { games: number | null; win_rate: number | null; scaling: Interval | null }

export interface CurvePoint {
  bucket_idx: number; bucket: string; mid_min: number;
  wins: number; games: number; win_rate: number; ci_low: number; ci_high: number; enough: boolean;
}
export interface Curve { hero_id: number; points: CurvePoint[] }

export interface IndexRow extends Interval {
  raw_pp_per_10min?: number; raw_ci_low?: number; raw_ci_high?: number;   // before the strength adjustment
  hero_id: number; games: number; win_rate: number; wr_ci_low: number; wr_ci_high: number;
}

interface Envelope { slice: Slice; sample: Sample | null }
export type HeroesResponse = Envelope & { heroes: HeroSummary[] };
export type CurvesResponse = Envelope & { curves: Curve[] };
export type IndexResponse = Envelope & { heroes: IndexRow[] };

export function sliceQuery(s: Slice, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams({ queue: s.queue, rank: s.rank, period: s.period });
  for (const [k, v] of Object.entries(extra)) p.append(k, String(v));
  return p.toString();
}

// Static mode (VITE_STATIC=1, used for GitHub Pages): there is no backend, so
// every API response is a pre-generated file (see api/export_static.py).
export const STATIC = import.meta.env.VITE_STATIC === "1";

/** "heroes?queue=ranked&rank=all&period=all" -> "<base>data/heroes/ranked_all_all.json" */
function staticUrl(path: string): { url: string; heroIds: number[] } {
  const [name, query = ""] = path.split("?");
  const q = new URLSearchParams(query);
  const heroIds = q.getAll("hero_id").map(Number);
  const base = `${import.meta.env.BASE_URL}data/${name}`;
  if (!q.has("queue")) return { url: `${base}.json`, heroIds };
  return { url: `${base}/${q.get("queue")}_${q.get("rank")}_${q.get("period")}.json`, heroIds };
}

export async function apiGet<T>(path: string): Promise<T> {
  if (!STATIC) {
    const r = await fetch(`/api/${path}`);
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`);
    return r.json();
  }
  const { url, heroIds } = staticUrl(path);
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status === 404 ? "No data for this filter combination" : `HTTP ${r.status}`);
  const d = await r.json();
  // the file holds every hero; the API's hero_id filter is applied here
  if (heroIds.length && Array.isArray(d.curves)) d.curves = d.curves.filter((c: Curve) => heroIds.includes(c.hero_id));
  return d;
}

/** Fetch JSON; keeps the previous data while a new request is in flight
 *  so charts hold their frame instead of flashing. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    apiGet<T>(path)
      .then((d) => { if (id === seq.current) { setData(d); setError(null); } })
      .catch((e: Error) => { if (id === seq.current) setError(e.message); })
      .finally(() => { if (id === seq.current) setLoading(false); });
  }, [path]);

  return { data, error, loading };
}

// --- What wins games (api/routers/win_factors.py) ---
export interface FactorDef { id: string; label: string; unit: string; description: string; group: string; step: string; ranked_only: boolean }
export interface FactorStat {
  id: string; available: boolean; sd: number | null; lead_share: number; lead_n: number;
  step_pp?: number; step_ci_low?: number; step_ci_high?: number;
  lead_win_rate: number | null; lead_ci_low: number | null; lead_ci_high: number | null;
  effect_pp: number | null; ci_low: number | null; ci_high: number | null;
}
export interface MinuteStat {
  minute: number; matches: number; train: number; test: number;
  metrics: { accuracy: number; auc: number; log_loss: number; brier: number; base_log_loss: number };
  factors: FactorStat[];
  corr: { vars: string[]; r: (number | null)[][] };
}
export interface CalibrationBin { bin: number; mean_pred: number; observed: number; ci_low: number; ci_high: number; n: number }
export interface WinFactorsResponse {
  slice: Slice; generated_at: string; source: string; days: number; min_matches: number;
  factors: FactorDef[];
  data: { minutes: MinuteStat[]; calibration: CalibrationBin[]; matches: number } | null;
}
