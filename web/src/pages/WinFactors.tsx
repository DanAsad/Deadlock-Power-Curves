import { useMemo, useState } from "react";
import { sliceQuery, useApi, type FactorDef, type FactorStat, type WinFactorsResponse } from "../api";
import { Calibration } from "../charts/Calibration";
import { CorrHeatmap, CorrLegend } from "../charts/CorrHeatmap";
import { EffectBars, type EffectRow } from "../charts/EffectBars";
import { TrendSmall } from "../charts/TrendSmall";
import { Loading, ViewToggle } from "../components/ui";
import { FilterBar, useSlice } from "../filters";
import { int, pct } from "../format";

const shortLabels: Record<string, string> = {
  won: "Won", souls: "Souls", kills: "Kills", levels: "Levels", last_hits: "Last hits", denies: "Denies",
  hero_damage: "Hero damage", guardians: "Guardians", walkers: "Walkers", base_guardians: "Base Guardians",
  shrines: "Shrines", mid_boss: "Mid-Boss", enemies_dead: "Enemies dead", enemy_dead_time: "Enemy time dead",
  enemy_abandons: "Enemy leavers", rank_gap: "Rank adv.", objective_damage: "Objective dmg",
  enemy_souls_lost: "Enemy souls lost", momentum: "Momentum", carry_concentration: "Carry conc.",
  draft_scaling: "Draft scaling", draft_strength: "Draft strength", hero_experience: "Hero exp.",
};

const unavailable = (f: FactorStat, fallback: string) => (f.available === false ? "ranked matches only" : fallback);
const stepLine = (f: FactorStat, d?: FactorDef) =>
  f.step_pp != null && d ? `${d.step} more: ${pct(0.5 + f.step_pp / 100)} (95% CI ${pct(0.5 + f.step_ci_low! / 100)} – ${pct(0.5 + f.step_ci_high! / 100)})` : "";

const pp1 = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} pp`;

function typical(sd: number, unit: string) {
  const v = sd >= 100 ? Math.round(sd / 100) * 100 : sd >= 10 ? Math.round(sd) : Math.round(sd * 10) / 10;
  return `${v.toLocaleString("en-US")} ${unit}`;
}

export function WinFactors() {
  const [slice] = useSlice();
  const { data, error, loading } = useApi<WinFactorsResponse>(`win-factors?${sliceQuery(slice)}`);
  const minutes = data?.data?.minutes ?? [];
  const [minute, setMinute] = useState(15);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [corrView, setCorrView] = useState<"chart" | "table">("chart");
  const cur = minutes.find((m) => m.minute === minute) ?? minutes.find((m) => m.minute >= minute) ?? minutes[minutes.length - 1];
  const defs = useMemo(() => new Map((data?.factors ?? []).map((f) => [f.id, f])), [data]);
  const label = (id: string) => defs.get(id)?.label ?? id;

  const byWeight = useMemo(() => {
    if (!cur) return [];
    return [...cur.factors].sort((a, b) => (b.effect_pp ?? -1e9) - (a.effect_pp ?? -1e9));
  }, [cur]);

  const weightRows: EffectRow[] = byWeight.map((f) => {
    const d = defs.get(f.id);
    return {
      id: f.id, label: label(f.id), value: f.effect_pp, lo: f.ci_low, hi: f.ci_high,
      note: unavailable(f, "not in play yet"),
      tooltip: f.effect_pp == null ? [] : [
        `${pct(0.5 + f.effect_pp / 100)} win chance`,
        `from an even game, with a ${typical(f.sd!, d?.unit ?? "")} lead (typical)`,
        `95% CI ${pp1(f.ci_low!)} to ${pp1(f.ci_high!)}`,
        stepLine(f, d),
      ].filter(Boolean),
    };
  });
  const aloneRows: EffectRow[] = [...(cur?.factors ?? [])]
    .sort((a, b) => (b.lead_win_rate ?? 0) - (a.lead_win_rate ?? 0))
    .map((f) => ({
      id: f.id, label: label(f.id),
      value: f.lead_win_rate != null && f.lead_share > 0.001 ? (f.lead_win_rate - 0.5) * 100 : null,
      lo: f.lead_ci_low != null ? (f.lead_ci_low - 0.5) * 100 : null,
      hi: f.lead_ci_high != null ? (f.lead_ci_high - 0.5) * 100 : null,
      note: unavailable(f, "no team ahead yet"),
      faded: f.lead_share < 0.05,
      tooltip: f.lead_win_rate == null ? [] : [
        `${pct(f.lead_win_rate)} won`,
        `95% CI ${pct(f.lead_ci_low!)} – ${pct(f.lead_ci_high!)}`,
        `a team was ahead in ${pct(f.lead_share, 0)} of games (${int(f.lead_n)})`,
      ],
    }));

  // over-time small multiples: one shared y-axis across factors
  const series = useMemo(() => {
    const out = new Map<string, { m: number; f: FactorStat }[]>();
    for (const m of minutes) for (const f of m.factors) if (f.effect_pp != null) {
      out.set(f.id, [...(out.get(f.id) ?? []), { m: m.minute, f }]);
    }
    return out;
  }, [minutes]);
  const yDomain = useMemo<[number, number]>(() => {
    const v = [...series.values()].flat().flatMap(({ f }) => [f.ci_low!, f.ci_high!]);
    return v.length ? [Math.min(0, ...v) - 1, Math.max(...v) + 1] : [0, 10];
  }, [series]);
  const xDomain: [number, number] = [0, Math.max(45, ...minutes.map((m) => m.minute)) + 2];
  const order = (data?.factors ?? []).map((f) => f.id)
    .sort((a, b) => Math.max(...(series.get(b) ?? []).map((s) => s.f.effect_pp!), -99) -
                    Math.max(...(series.get(a) ?? []).map((s) => s.f.effect_pp!), -99));

  const met = cur?.metrics;
  return (
    <>
      <h1>What wins games</h1>
      <p className="lede">
        Which in-game leads matter most for winning, and when. At each snapshot minute we compare the two teams on
        souls, kills, objectives and more, then measure how strongly each lead is tied to the final result.
      </p>
      {data?.source === "demo" && (
        <p className="note banner"><span aria-hidden>⚠</span><span><b>Demo data.</b> Run <code>python -m pipeline.win_factors --days 2</code> for real matches.</span></p>
      )}
      <FilterBar sample={data?.data ? { matches: data.data.matches, player_rows: 0 } : null}
                 range={data ? `last ${data.days} complete days · all patches` : undefined} />
      <div className="filters">
        <div className="filter">
          <label id="minute-label">Game minute</label>
          <div className="seg" role="group" aria-labelledby="minute-label">
            {minutes.map((m) => (
              <button key={m.minute} aria-pressed={cur?.minute === m.minute} onClick={() => setMinute(m.minute)}>
                {m.minute}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <Loading loading={loading}>
        {cur && met && (
          <div className="tiles">
            <Tile label={`Matches at minute ${cur.minute}`} value={int(cur.matches)}
                  sub={`${int(cur.train)} to fit · ${int(cur.test)} held out`} />
            <Tile label="Predicts the winner" value={pct(met.accuracy)}
                  sub="on held-out matches, from these factors alone" />
            <Tile label="AUC" value={met.auc.toFixed(3)} sub="0.5 = coin flip, 1 = perfect" />
            <Tile label="Log loss · Brier" value={`${met.log_loss.toFixed(3)} · ${met.brier.toFixed(3)}`}
                  sub={`coin flip: ${met.base_log_loss.toFixed(3)} · 0.250`} />
          </div>
        )}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div>
              <h2>Unique weight at minute {cur?.minute ?? "–"}</h2>
              <span className="muted small">
                Win chance from an even game for a typical lead (1 standard deviation) in that factor alone,
                holding the others fixed · logistic regression, 95% CI · faded = CI includes 0
              </span>
            </div>
            <ViewToggle value={view} onChange={setView} />
          </div>
          {view === "chart" ? (
            <EffectBars rows={weightRows} label="Unique weight of each factor" tick={(v) => pct(0.5 + v / 100, 0)} minExtent={5} />
          ) : (
            <FactorTable factors={byWeight} defs={defs} />
          )}
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h2>On its own: how often the team ahead wins</h2>
          <span className="muted small">
            Teams tied in a factor are left out. Factors overlap (a souls lead usually comes with kills and levels), so
            these don't add up. The unique weights above split that shared credit. Faded = a team was ahead in under 5% of
            games, so the rate describes rare games.
          </span>
          <EffectBars rows={aloneRows} label="Win rate of the team ahead in each factor" tick={(v) => pct(0.5 + v / 100, 0)} minExtent={10} />
        </div>

        {cur && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div>
                <h2>How the factors move together at minute {cur.minute}</h2>
                <span className="muted small">
                  Pearson correlation of the team differences across {int(cur.matches)} matches. The “Won” column is each
                  lead's direct link to winning. Factors that move together share credit in the unique weights above.
                </span>
              </div>
              <ViewToggle value={corrView} onChange={setCorrView} />
            </div>
            {corrView === "chart" ? (
              <>
                <CorrLegend />
                <CorrHeatmap vars={cur.corr.vars} r={cur.corr.r} labels={shortLabels} n={cur.matches} />
              </>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th />{cur.corr.vars.map((v) => <th key={v}>{shortLabels[v] ?? v}</th>)}</tr></thead>
                  <tbody>
                    {cur.corr.vars.map((v, i) => (
                      <tr key={v}>
                        <td>{shortLabels[v] ?? v}</td>
                        {cur.corr.r[i].map((x, j) => <td key={j}>{x == null ? "–" : x.toFixed(2)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="card" style={{ marginBottom: 16 }}>
          <h2>How each weight changes over the game</h2>
          <span className="muted small">Unique weight by minute (shared axis) · band = 95% CI · shaded column = selected minute</span>
          <div className="multiples" style={{ marginTop: 12 }}>
            {order.map((id) => (
              <div key={id} className="card multiple" style={{ background: "var(--surface)" }}>
                <div className="title">{label(id)}<span>{defs.get(id)?.unit}</span></div>
                <TrendSmall
                  name={label(id)} yDomain={yDomain} xDomain={xDomain} highlightX={cur?.minute}
                  empty={defs.get(id)?.ranked_only && slice.queue !== "ranked" ? "Ranked matches only" : undefined}
                  formatY={(v) => pct(0.5 + v / 100, 0)}
                  points={(series.get(id) ?? []).map(({ m, f }) => ({
                    x: m, y: f.effect_pp!, lo: f.ci_low!, hi: f.ci_high!,
                    lines: [`${pct(0.5 + f.effect_pp! / 100)} win chance`, `minute ${m}`,
                            `lead of ${typical(f.sd!, defs.get(id)?.unit ?? "")}`],
                  }))} />
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Is the model honest? Calibration on held-out matches</h2>
          <span className="muted small">
            All minutes pooled. Points on the diagonal mean a predicted 70% wins about 70% of the time. Bars = 95% CI.
            Train/test split is by match, so no game appears in both.
          </span>
          {data?.data && <Calibration bins={data.data.calibration} />}
        </div>
      </Loading>

      <p className="note">
        <span aria-hidden>ⓘ</span>
        <span>
          <b>These are associations, not causes.</b> A souls lead predicts wins partly because better teams get both.
          Later minutes only include games that lasted that long. The final game-end snapshot and the Patron/Core
          objectives are excluded, so the result never leaks into the inputs.
        </span>
      </p>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function FactorTable({ factors, defs }: { factors: FactorStat[]; defs: Map<string, FactorDef> }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Factor</th><th>Type</th><th>Unique weight</th><th>95% CI</th><th>Typical lead (1 SD)</th>
              <th>Per step (from an even game)</th><th>Team ahead wins</th><th>Games with a lead</th></tr>
        </thead>
        <tbody>
          {factors.map((f) => (
            <tr key={f.id} className={f.effect_pp == null ? "dim" : ""}>
              <td title={defs.get(f.id)?.description}>{defs.get(f.id)?.label ?? f.id}</td>
              <td>{defs.get(f.id)?.group ?? ""}</td>
              <td>{f.effect_pp != null ? pp1(f.effect_pp) : "–"}</td>
              <td>{f.ci_low != null ? `${pp1(f.ci_low)} to ${pp1(f.ci_high!)}` : "–"}</td>
              <td>{f.effect_pp != null ? typical(f.sd!, defs.get(f.id)?.unit ?? "") : "–"}</td>
              <td>{f.step_pp != null ? `${defs.get(f.id)?.step}: ${pct(0.5 + f.step_pp / 100)}` : f.available === false ? "ranked only" : "–"}</td>
              <td>{f.lead_win_rate != null ? pct(f.lead_win_rate) : "–"}</td>
              <td>{pct(f.lead_share, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
