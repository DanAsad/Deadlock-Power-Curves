// Items: which shop items win games once you account for who can afford them
// (pipeline/items.py). Raw item win rates mostly measure "the team that was ahead bought
// it"; each purchase here is compared with the same hero in the same game state.
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { sliceQuery, useApi } from "../api";
import { EffectBars, type EffectRow } from "../charts/EffectBars";
import { ItemScatter, SLOT_STYLE, SlotLegend, type ItemPoint } from "../charts/ItemScatter";
import { Loading, ViewToggle } from "../components/ui";
import { FilterBar, useSlice } from "../filters";
import { int, pct } from "../format";

interface ItemInfo { id: number; name: string; tier: number | null; cost: number | null; slot: string | null; image: string | null }
interface ItemsResponse {
  first_day: string; last_day: string; min_games: number; buckets: string[]; items: ItemInfo[]; own_souls?: boolean;
  cols: string[]; timing_cols: string[]; rows: (number | null)[][]; timing: Record<string, number[][]>;
}
interface ItemRow { item_id: number; n: number; win_rate: number; expected: number; effect: number; ci_low: number; ci_high: number; lead: number; median_bucket: number | null;
  own?: number | null; effect_team?: number | null }   // own, effect_team: since 2026-11-16 (buyer's souls in the state)
const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const toObj = <T,>(cols: string[], r: (number | null)[]) => Object.fromEntries(cols.map((c, i) => [c, r[i]])) as T;

export function Items() {
  const [slice] = useSlice();
  const [params, setParams] = useSearchParams();
  const r = useApi<ItemsResponse>(`items?${sliceQuery(slice)}`);
  const [slot, setSlot] = useState("all");
  const [tier, setTier] = useState("all");
  const [all, setAll] = useState(false);
  const [view, setView] = useState<"chart" | "table">("chart");
  const info = useMemo(() => new Map((r.data?.items ?? []).map((x) => [x.id, x])), [r.data]);
  const rows = useMemo(() => (r.data?.rows ?? []).map((x) => toObj<ItemRow>(r.data!.cols, x)), [r.data]);
  const shown = rows.filter((x) => {
    const i = info.get(x.item_id);
    return (slot === "all" || i?.slot === slot) && (tier === "all" || String(i?.tier) === tier);
  });
  const name = (id: number) => info.get(id)?.name ?? `Item ${id}`;
  const selId = Number(params.get("item")) || shown[0]?.item_id;
  const sel = rows.find((x) => x.item_id === selId);
  const select = (id: number) => { const p = new URLSearchParams(params); p.set("item", String(id)); setParams(p, { replace: true }); };

  const points: ItemPoint[] = shown.map((x) => ({ id: x.item_id, name: name(x.item_id), slot: info.get(x.item_id)?.slot ?? "", raw: (x.win_rate - 0.5) * 100,
    effect: x.effect, n: x.n, selected: x.item_id === selId }));
  const rawMean = points.length ? points.reduce((s, p) => s + Math.abs(p.raw), 0) / points.length : 0;
  const adjMean = points.length ? points.reduce((s, p) => s + Math.abs(p.effect), 0) / points.length : 0;
  const own = !!r.data?.own_souls;
  const teamMean = own && shown.length ? shown.reduce((s, x) => s + Math.abs(x.effect_team ?? 0), 0) / shown.length : null;
  const ranked = all || shown.length <= 24 ? shown : [...shown.slice(0, 12), ...shown.slice(-12)];
  const bars: EffectRow[] = ranked.map((x) => ({
    id: String(x.item_id), label: name(x.item_id), value: x.effect, lo: x.ci_low, hi: x.ci_high,
    tooltip: [`${signed(x.effect)} pp beyond the game state`, `buyers won ${pct(x.win_rate)}; expected ${pct(x.expected)}`,
      `95% CI ${signed(x.ci_low)} to ${signed(x.ci_high)} · ${int(x.n)} purchases`, "click the item's name in the table for timing"],
  }));
  const tc = r.data?.timing_cols ?? [];
  const timing = sel && r.data ? (r.data.timing[String(sel.item_id)] ?? []).map((t) => toObj<{ bucket: number; n: number; win_rate: number; expected: number; effect: number; ci_low: number; ci_high: number }>(tc, t)) : [];
  const timingBars: EffectRow[] = timing.map((t) => ({
    id: String(t.bucket), label: `${r.data!.buckets[t.bucket]} min`, value: t.effect, lo: t.ci_low, hi: t.ci_high,
    tooltip: [`${signed(t.effect)} pp`, `bought at ${r.data!.buckets[t.bucket]} min: won ${pct(t.win_rate)}, expected ${pct(t.expected)}`, `${int(t.n)} purchases`],
  }));
  const si = sel ? info.get(sel.item_id) : undefined;

  return (
    <>
      <h1>Items</h1>
      <p className="lede">
        Which items actually win games? Not the raw win rate: the team that is ahead has more souls and buys more, so
        nearly every item looks good. Each purchase is compared with the same hero in the same game state: the team's
        soul lead, {r.data?.own_souls ? "the buyer's own souls, " : ""}and the minute when it was bought.
      </p>
      <FilterBar count={r.data ? `${int(rows.reduce((a, x) => a + x.n, 0))} purchases` : undefined}
                 range={r.data ? `${r.data.first_day} – ${r.data.last_day}` : undefined} />
      {r.error && <p className="error">{r.error}</p>}
      <Loading loading={r.loading}>
        <div className="filters" role="group" aria-label="Item filters">
          <div className="filter">
            <label htmlFor="it-slot">Slot</label>
            <select id="it-slot" value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="all">All slots</option>
              {Object.entries(SLOT_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div className="filter">
            <label htmlFor="it-tier">Tier</label>
            <select id="it-tier" value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="all">All tiers</option>
              {[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>Tier {t}</option>)}
            </select>
          </div>
          <div className="filter">
            <label htmlFor="it-item">Item</label>
            <select id="it-item" value={selId ?? ""} onChange={(e) => select(Number(e.target.value))}>
              {[...shown].sort((a, b) => name(a.item_id).localeCompare(name(b.item_id))).map((x) => <option key={x.item_id} value={x.item_id}>{name(x.item_id)}</option>)}
            </select>
          </div>
        </div>

        {sel && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {si?.image && <img src={si.image} alt="" width={36} height={36} style={{ borderRadius: 6, background: "var(--surface-2)" }} />}
                <div>
                  <h2 style={{ margin: 0 }}>{name(sel.item_id)}</h2>
                  <span className="muted small">{si?.slot ? SLOT_STYLE[si.slot]?.label : ""}{si?.tier ? ` · tier ${si.tier}` : ""}{si?.cost ? ` · ${int(si.cost)} souls` : ""}</span>
                </div>
              </div>
            </div>
            <div className="tiles">
              <div className="tile"><div className="label">Effect beyond the game state</div><div className="value">{signed(sel.effect)} pp</div><div className="sub">95% CI {signed(sel.ci_low)} to {signed(sel.ci_high)}</div></div>
              <div className="tile"><div className="label">Buyers won</div><div className="value">{pct(sel.win_rate)}</div><div className="sub">expected {pct(sel.expected)} from hero and game state</div></div>
              <div className="tile"><div className="label">Team soul lead when bought</div><div className="value">{signed(sel.lead)}%</div><div className="sub">of all souls, on average</div></div>
              {sel.own != null && (
                <div className="tile"><div className="label">Buyer's own souls when bought</div><div className="value">{signed(sel.own, 0)}%</div><div className="sub">vs the match's average player</div></div>
              )}
              <div className="tile"><div className="label">Purchases</div><div className="value">{int(sel.n)}</div><div className="sub">{sel.median_bucket != null && r.data ? `usually bought at ${r.data.buckets[sel.median_bucket]} min` : ""}</div></div>
            </div>
            {timingBars.length > 1 && (
              <>
                <h3 className="sub-h">By when it was bought</h3>
                <p className="muted small" style={{ margin: "0 0 6px" }}>Effect beyond the game state, by purchase minute. Early buys of a late item often say more about the game than the item.</p>
                <EffectBars rows={timingBars} tick={(v) => `${signed(v, 0)} pp`} label={`${name(sel.item_id)} by purchase minute`} />
              </>
            )}
          </div>
        )}

        <div className="pair-grid">
          <div className="card">
            <h2>Raw vs adjusted</h2>
            <p className="muted small" style={{ margin: "0 0 6px" }}>
              Average size of the raw edge {rawMean.toFixed(1)} pp;
              {teamMean != null ? <> {teamMean.toFixed(1)} pp after accounting for the team's soul lead, and {adjMean.toFixed(1)} pp once the buyer's own souls are added.</> : <> after the adjustment {adjMean.toFixed(1)} pp.</>}{" "}
              Points below the dashed line on the right got part of their raw edge from the game state, not the item.
            </p>
            <SlotLegend />
            <ItemScatter points={points} onSelect={select} />
          </div>
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Ranking</h2>
                <span className="muted small">Effect beyond the game state, 95% CI; {ranked.length < shown.length ? "the 12 best and 12 worst" : `all ${shown.length}`}</span>
              </div>
              <span style={{ display: "flex", gap: 8 }}>
                {shown.length > 24 && <button className="btn" onClick={() => setAll((v) => !v)}>{all ? "Best and worst 12" : "Show all"}</button>}
                <ViewToggle value={view} onChange={setView} />
              </span>
            </div>
            {view === "chart" ? (
              <EffectBars rows={bars} tick={(v) => `${signed(v, 0)} pp`} label="Item effect beyond the game state" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th style={{ textAlign: "left" }}>Item</th><th>Effect</th><th>95% CI</th><th>Won</th><th>Expected</th><th>Purchases</th></tr></thead>
                  <tbody>
                    {ranked.map((x) => (
                      <tr key={x.item_id} aria-selected={x.item_id === selId}>
                        <td style={{ textAlign: "left" }}><button className="linkish" onClick={() => select(x.item_id)}>{name(x.item_id)}</button></td>
                        <td>{signed(x.effect)} pp</td><td>{signed(x.ci_low)} to {signed(x.ci_high)}</td>
                        <td>{pct(x.win_rate)}</td><td>{pct(x.expected)}</td><td>{int(x.n)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </Loading>
      <p className="note">
        <span aria-hidden>ⓘ</span>
        <span>
          <b>How it works.</b> For every player at every stat snapshot, the win rate is measured by game minute and team soul
          lead (2-point bins){own ? <>, and the player's own souls compared with the match's average player (15-point bins)</> : null}; each hero also gets its own edge beyond that. An item's expected win rate is that baseline for
          its buyers' heroes, minutes and leads at the moment they bought it. A player's first purchase of an item counts
          once; matches where someone left are not counted; items need {r.data ? int(r.data.min_games) : "2,000"} purchases.
          This still is not a controlled experiment.{" "}
          {own
            ? <>The state does not see what happens between stat snapshots (up to 5 minutes), and
              defensive or counter items are often bought by players already under pressure, so some of their low numbers are the
              situation, not the item.</>
            : <>The state is the <i>team's</i> soul lead, not the buyer's own souls, so expensive items still look a little better
              (only a well-farmed player can buy them), and defensive or counter items are often bought by players already under pressure.</>}{" "}
          Teammates' purchases in the same match are not independent, so the intervals are a little narrow.
        </span>
      </p>
    </>
  );
}
