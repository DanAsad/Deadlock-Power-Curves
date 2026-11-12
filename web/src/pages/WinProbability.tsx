// Phase 2 slot. Add api/routers/win_probability.py and replace this page.
export function WinProbability() {
  return (
    <div className="placeholder">
      <h1>Win probability</h1>
      <p className="lede">Coming in Phase 2: a per-match win-probability graph, annotated with kills and objectives.</p>
      <div className="card">
        <h2>Plan</h2>
        <ol>
          <li>Training rows from the lake's per-player <code>stats.*</code> snapshots (souls, kills, objectives over time).</li>
          <li>Logistic regression baseline, then gradient boosting. Train/test split by match, never by row.</li>
          <li>Report Brier score, log loss and a calibration curve.</li>
          <li>Enter a match ID → win-probability line for spectators, public and pro matches.</li>
        </ol>
      </div>
    </div>
  );
}
