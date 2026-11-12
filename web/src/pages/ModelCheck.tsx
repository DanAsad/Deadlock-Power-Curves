import { useState } from "react";
import { useApi, type CalibrationBin } from "../api";
import { Calibration } from "../charts/Calibration";
import { EffectBars, type EffectRow } from "../charts/EffectBars";
import { LossLines } from "../charts/LossLines";
import { Loading, ViewToggle } from "../components/ui";
import { int, pct } from "../format";

interface Scores { log_loss: number; brier: number; accuracy: number; auc: number }
interface Delta { delta_log_loss: number; ci_low: number; ci_high: number }
interface Ablation extends Delta {
  group: string; label: string; factors: string[];
  share_of_gain: number | null; share_ci_low: number | null; share_ci_high: number | null;
}
interface MinuteEval {
  minute: number; n_train: number; n_test: number;
  models: Record<string, Scores>; ablation: Ablation[];
  beyond_souls: Delta; new_info?: Delta;
  calibration: CalibrationBin[]; ece: number;
  calibration_unified?: CalibrationBin[]; ece_unified?: number;
  unified_vs_full?: Delta;
}
interface ModelInfo { iterations: number; train_matches: number; features: string[]; overall: Scores }
interface Segment extends Scores { id: string; label: string; matches: number; ece: number }
interface QueueModel {
  queue: string; label: string; matches: number; shared_log_loss: number; own_log_loss: number;
  own_vs_shared: Delta; own_rank_log_loss?: number; rank_vs_own?: Delta;
}
interface EveryMinute {
  matches: number;
  minutes: (Scores & { minute: number; n: number; snapshot: boolean; ece: number })[];
  between_snapshots: (Delta & {
    from: number; to: number; rows: number; every_minute_log_loss: number; snapshot_only_log_loss: number;
    every_minute_ece: number; snapshot_only_ece: number;
  })[];
}
interface SplitEval {
  label: string; train_days: number | null; test_day: string | null;
  matches_train: number; matches_test: number; minutes: MinuteEval[];
  unified?: ModelInfo; live?: ModelInfo;
  segments?: Segment[]; queue_models?: QueueModel[]; every_minute?: EveryMinute | null;
}
interface EvalResponse {
  generated_at: string; source: string; days: number; first_day: string; last_day: string;
  latest_patch?: string | null;
  splits: Record<string, SplitEval>;
}

const f3 = (v: number) => v.toFixed(3);
const f4 = (v: number) => v.toFixed(4);
const ci = (d: Delta) => `${f4(d.ci_low)} to ${f4(d.ci_high)}`;
// a difference is "clear" when its 95% CI excludes zero
const verdict = (d: Delta, better: string, worse: string) =>
  d.ci_low > 0 ? better : d.ci_high < 0 ? worse : "no clear difference";

export function ModelCheck() {
  const { data, error, loading } = useApi<EvalResponse>("model-eval");
  const splitIds = Object.keys(data?.splits ?? {});
  const [splitId, setSplitId] = useState("time");
  const sp = data?.splits[splitId] ?? data?.splits[splitIds[0]];
  const [minute, setMinute] = useState(15);
  const [view, setView] = useState<"chart" | "table">("chart");
  const cur = sp?.minutes.find((m) => m.minute === minute) ?? sp?.minutes[0];
  const gain = cur ? cur.models.coin.log_loss - cur.models.full.log_loss : 0;
  const hasUni = !!cur?.models.unified;
  const hasBase = !!cur?.models.base;
  const hasLive = !!cur?.models.live;
  const main = cur ? (cur.models.unified ?? cur.models.full) : null;      // headline model
  const uvf = cur?.unified_vs_full;
  const mins = sp?.minutes ?? [];
  const em = sp?.every_minute;
  const emAll = em?.between_snapshots.find((b) => b.from === 1 && b.to === 45);

  const ablRows: EffectRow[] = (cur?.ablation ?? [])
    .slice().sort((a, b) => (b.share_of_gain ?? 0) - (a.share_of_gain ?? 0))
    .map((a) => ({
      id: a.group, label: a.label,
      value: a.share_of_gain != null ? a.share_of_gain * 100 : null,
      lo: a.share_ci_low != null ? a.share_ci_low * 100 : null,
      hi: a.share_ci_high != null ? a.share_ci_high * 100 : null,
      tooltip: [
        `${pct(a.share_of_gain ?? 0)} of the gain lost`,
        `without ${a.factors.length} factors: log loss +${f4(a.delta_log_loss)} (95% CI ${f4(a.ci_low)} to ${f4(a.ci_high)})`,
      ],
    }));

  return (
    <>
      <h1>Model check</h1>
      <p className="lede">
        How well the team prediction from “What wins games” really predicts winners, measured only on matches the
        model never saw. Every later improvement, and the win-probability graph, will be judged against these numbers.
      </p>
      {data?.source === "demo" && (
        <p className="note banner"><span aria-hidden>⚠</span><span><b>Demo data.</b> Run <code>python -m pipeline.evaluate --days 10</code> for real matches.</span></p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="filters">
        <div className="filter">
          <label id="split-label">Test matches</label>
          <div className="seg" role="group" aria-labelledby="split-label">
            {splitIds.map((id) => (
              <button key={id} aria-pressed={sp === data?.splits[id]} onClick={() => setSplitId(id)}>
                {data!.splits[id].label}
              </button>
            ))}
          </div>
        </div>
        <div className="filter">
          <label id="ev-minute-label">Game minute</label>
          <div className="seg" role="group" aria-labelledby="ev-minute-label">
            {mins.map((m) => (
              <button key={m.minute} aria-pressed={cur?.minute === m.minute} onClick={() => setMinute(m.minute)}>{m.minute}</button>
            ))}
          </div>
        </div>
        {sp && (
          <div className="sample">
            <b className="num">{int(sp.matches_train)}</b> training · <b className="num">{int(sp.matches_test)}</b> test matches
            <br />
            {sp.test_day ? `trained on ${sp.train_days} days, tested on ${sp.test_day}` : `${data?.first_day} – ${data?.last_day}, mixed`}
            {data?.latest_patch && <> · patch {data.latest_patch}</>}
          </div>
        )}
      </div>

      <Loading loading={loading}>
        {cur && (
          <div className="tiles">
            <Tile label={`Picks the winner at minute ${cur.minute}`} value={pct(main!.accuracy)}
                  sub={hasBase ? `before the new factors ${pct(cur.models.base.accuracy)} · souls only ${pct(cur.models.souls_only.accuracy)}`
                               : `souls lead alone: ${pct(cur.models.souls_only.accuracy)} · coin flip 50%`} />
            <Tile label="Log loss (lower = better)" value={f3(main!.log_loss)}
                  sub={hasBase ? `before ${f3(cur.models.base.log_loss)} · souls only ${f3(cur.models.souls_only.log_loss)} · coin ${f3(cur.models.coin.log_loss)}`
                               : `souls only ${f3(cur.models.souls_only.log_loss)} · coin flip ${f3(cur.models.coin.log_loss)}`} />
            <Tile label="Brier score (lower = better)" value={f3(main!.brier)}
                  sub={`${hasBase ? `before ${f3(cur.models.base.brier)} · ` : ""}souls only ${f3(cur.models.souls_only.brier)} · coin 0.250`} />
            <Tile label="Calibration error (ECE)" value={pct(cur.ece_unified ?? cur.ece, 1)}
                  sub={`AUC ${f3(main!.auc)} · ${int(cur.n_test)} test matches`} />
          </div>
        )}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div>
              <h2>Log loss by minute</h2>
              <span className="muted small">
                How surprised the model is by real results, averaged over test matches. Lower is better; a coin flip
                scores 0.693. Shaded column = selected minute.
              </span>
            </div>
            <ViewToggle value={view} onChange={setView} />
          </div>
          {view === "chart" ? (
            <>
              <div className="legend">
                <span><i className="ln" style={{ background: "var(--series)" }} />{hasUni ? "Full model" : "Per-minute model"}</span>
                {hasLive && <span><i className="ln" style={{ background: "var(--cat-2)" }} />Live model (live-API fields only)</span>}
                {hasBase && <span><i className="ln" style={{ background: "var(--cat-3)" }} />Before the new factors</span>}
                <span><i className="ln" style={{ background: "var(--muted)" }} />Souls lead only</span>
                <span><i className="ln" style={{ background: "var(--axis)" }} />Coin flip</span>
              </div>
              <LossLines yLabel="Log loss" format={f3} highlightX={cur?.minute}
                reference={{ y: Math.log(2), label: "coin flip" }}
                series={[
                  { id: "souls", label: "souls lead only", color: "var(--muted)",
                    points: mins.map((m) => ({ x: m.minute, y: m.models.souls_only.log_loss })) },
                  ...(hasLive ? [{ id: "live", label: "live model", color: "var(--cat-2)",
                    points: mins.map((m) => ({ x: m.minute, y: m.models.live.log_loss })) }] : []),
                  ...(hasBase ? [{ id: "base", label: "before the new factors", color: "var(--cat-3)",
                    points: mins.map((m) => ({ x: m.minute, y: m.models.base.log_loss })) }] : []),
                  { id: "main", label: hasUni ? "full model" : "per-minute model", color: "var(--series)",
                    points: mins.map((m) => ({ x: m.minute, y: (m.models.unified ?? m.models.full).log_loss })) },
                ]} />
              {cur && (
                <ul className="muted small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {cur.new_info && hasBase && (
                    <li>
                      New factors (player history, hero pairs, lane state, respawn timers) at minute {cur.minute}:{" "}
                      {verdict(cur.new_info, "better", "worse")}, log loss {f4(cur.new_info.delta_log_loss)} lower
                      (95% CI {ci(cur.new_info)}).
                    </li>
                  )}
                  {uvf && (
                    <li>
                      One model for the whole game vs a separate model per minute:{" "}
                      {verdict(uvf, "better", "worse")}, {f4(uvf.delta_log_loss)} (95% CI {ci(uvf)}).
                      {sp?.unified && <> Trained on {int(sp.unified.train_matches)} matches, {sp.unified.iterations} trees.</>}
                    </li>
                  )}
                  {hasLive && (
                    <li>
                      Live model, using only what the live-matches API shows during a game: log loss{" "}
                      {f3(cur.models.live.log_loss)}, picks the winner {pct(cur.models.live.accuracy)} of the time.
                    </li>
                  )}
                </ul>
              )}
            </>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Minute</th><th>Test matches</th><th>Log loss: full model</th><th>per-minute</th>
                  {hasBase && <th>before new factors</th>}{hasLive && <th>live model</th>}<th>souls only</th>
                  <th>Accuracy</th>{hasLive && <th>live</th>}<th>Brier</th><th>AUC</th><th>ECE</th></tr></thead>
                <tbody>
                  {mins.map((m) => {
                    const b = m.models.unified ?? m.models.full;
                    return (
                      <tr key={m.minute}>
                        <td>{m.minute}</td><td>{int(m.n_test)}</td>
                        <td>{m.models.unified ? f4(m.models.unified.log_loss) : "–"}</td>
                        <td>{f4(m.models.full.log_loss)}</td>
                        {hasBase && <td>{f4(m.models.base.log_loss)}</td>}
                        {hasLive && <td>{f4(m.models.live.log_loss)}</td>}
                        <td>{f4(m.models.souls_only.log_loss)}</td>
                        <td>{pct(b.accuracy)}</td>{hasLive && <td>{pct(m.models.live.accuracy)}</td>}
                        <td>{f4(b.brier)}</td><td>{f3(b.auc)}</td><td>{pct(m.ece_unified ?? m.ece, 1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {cur && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>What each factor group adds at minute {cur.minute} <span className="muted small">(per-minute model)</span></h2>
            <span className="muted small">
              The model is refit without one group at a time. Bar = share of the model's improvement over a coin flip
              that is lost without it (95% CI, paired over the same test matches). Groups overlap, so the shares can add
              up to less than 100%. Everything beyond the souls lead adds{" "}
              <b>{pct(gain > 0 ? cur.beyond_souls.delta_log_loss / gain : 0)}</b> of the gain.
            </span>
            <EffectBars rows={ablRows} label="Share of the gain lost without each group" tick={(v) => `${Math.round(v)}%`} minExtent={10} />
          </div>
        )}

        {cur && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Calibration at minute {cur.minute}{hasUni && <span className="muted small"> (full model)</span>}</h2>
            <span className="muted small">
              Test matches grouped by predicted win chance. On the diagonal, a predicted 70% wins 70% of the time.
              Average gap (ECE): {pct(cur.ece_unified ?? cur.ece, 1)}{hasUni && <> · per-minute model: {pct(cur.ece, 1)}</>}. Bars = 95% CI.
            </span>
            <Calibration bins={cur.calibration_unified ?? cur.calibration} />
          </div>
        )}

        {em && em.minutes.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Every game minute</h2>
            <span className="muted small">
              The full model at each minute from 1 to 45, on {int(em.matches)} test matches that have a row per minute.
              Player stats are only recorded every 3 to 5 minutes, so between those snapshots the model works with the
              last recorded values (up to 4 minutes old) and is told how old they are; objectives, deaths and respawn
              timers are exact at every minute. That is why the line steps down at each snapshot.
            </span>
            <LossLines yLabel="Log loss" format={f3} reference={{ y: Math.log(2), label: "coin flip" }}
              series={[{ id: "em", label: "full model", color: "var(--series)",
                points: em.minutes.map((m) => ({ x: m.minute, y: m.log_loss })) }]} />
            {emAll && (
              <p className="muted small" style={{ margin: "6px 0 8px" }}>
                Training on every minute instead of only the snapshot minutes, tested between snapshots:{" "}
                {verdict(emAll, "better", "worse")}, log loss {f4(emAll.delta_log_loss)} lower (95% CI {ci(emAll)}).
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Minutes (between snapshots)</th><th>Rows</th><th>Log loss: trained on every minute</th>
                  <th>trained on snapshots only</th><th>Difference (95% CI)</th><th>ECE: every minute</th><th>snapshots only</th></tr></thead>
                <tbody>
                  {em.between_snapshots.map((b) => (
                    <tr key={`${b.from}-${b.to}`}>
                      <td>{b.from === 1 && b.to === 45 ? "All" : `${b.from}–${b.to}`}</td><td>{int(b.rows)}</td>
                      <td>{f4(b.every_minute_log_loss)}</td><td>{f4(b.snapshot_only_log_loss)}</td>
                      <td>{f4(b.delta_log_loss)} ({ci(b)})</td>
                      <td>{pct(b.every_minute_ece, 1)}</td><td>{pct(b.snapshot_only_ece, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {sp?.segments && sp.segments.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>By queue</h2>
            <span className="muted small">
              The full model on each kind of match, all snapshot minutes together. The queue is an input, so the model
              can be more or less sure in each. A match can be in more than one row. The notes below test simple
              per-minute models; because separate weights win for ranked, the full model keeps its own weights per queue. The notes below test simple
              per-minute models; because separate weights win for ranked, the full model keeps its own weights per queue.
            </span>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Matches</th><th>Test matches</th><th>Accuracy</th><th>Log loss</th><th>Brier</th><th>AUC</th><th>ECE</th></tr></thead>
                <tbody>
                  {sp.segments.map((s) => (
                    <tr key={s.id}>
                      <td>{s.label}</td><td>{int(s.matches)}</td><td>{pct(s.accuracy)}</td><td>{f4(s.log_loss)}</td>
                      <td>{f4(s.brier)}</td><td>{f3(s.auc)}</td><td>{pct(s.ece, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(sp.queue_models ?? []).length > 0 && (
              <ul className="muted small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {sp.queue_models!.map((q) => (
                  <li key={q.queue}>
                    <b>{q.label}:</b> a model trained only on {q.label.toLowerCase()} matches vs the shared one:{" "}
                    {verdict(q.own_vs_shared, "separate is better", "shared is better")} (log loss {f4(q.own_log_loss)} vs{" "}
                    {f4(q.shared_log_loss)}; difference {f4(q.own_vs_shared.delta_log_loss)}, 95% CI {ci(q.own_vs_shared)}).
                    {q.rank_vs_own && (
                      <> Adding the teams' rank gap: {verdict(q.rank_vs_own, "helps", "hurts")} ({f4(q.rank_vs_own.delta_log_loss)},
                        95% CI {ci(q.rank_vs_own)}).</>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Loading>

      <p className="note">
        <span aria-hidden>ⓘ</span>
        <span>
          <b>Full model</b>: one gradient-boosted model over all game minutes, so it can give a win chance at any
          moment. It takes a straight-line score of all factors as one input, treats both teams the same, and is
          recalibrated on matches it never trained on. Ranked and unranked matches get their own weights, and ranked
          matches also use the teams' rank gap. <b>Live model</b>: the same, limited to what the live-matches
          API shows during a game (team souls, objectives, heroes, players); it has no kills, deaths or per-player
          stats. <b>Two ways to test.</b> “Newest day held out” trains on earlier days and tests on the latest, like a
          live system would; it's the honest number. “Random 20% of matches” mixes days, so it can look slightly
          better. Either way, no match is in both training and test, and hero and player history comes only from days
          before each match.
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
