export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
export const pp = (v: number, digits = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)} pp`;
export const int = (v: number) => v.toLocaleString("en-US");
export const compact = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(0)}K` : int(v);
export const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
