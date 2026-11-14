// About: the project in two minutes, for visitors who won't open every tab.
// Headline numbers come from the same files as the other pages, so they stay current.
import { Link } from "react-router-dom";
import { useApi } from "../api";
import { useMeta } from "../filters";
import { pct } from "../format";

export const AUTHOR = { name: "Dan Asad", linkedin: "https://www.linkedin.com/in/danasad/", github: "https://github.com/DanAsad" };
export const REPO = "https://github.com/DanAsad/Deadlock-Power-Curves";

interface Scores { log_loss: number; accuracy: number }
interface EvalLite {
  splits: Record<string, {
    test_day: string | null; matches_train: number; matches_test: number;
    unified?: { overall: Scores }; segments?: { id: string; ece: number }[];
    minutes: { minute: number; models: Record<string, Scores> }[];
  }>;
}

const millions = (n: number) => `${(n / 1e6).toFixed(1)}M`;

export function About() {
  const meta = useMeta();
  const ev = useApi<EvalLite>("model-eval");
  const t = ev.data?.splits.time;
  const at = (m: number) => t?.minutes.find((x) => x.minute === m)?.models.unified?.accuracy;
  const ece = t?.segments?.find((s) => s.id === "all")?.ece;
  const phase1 = meta?.sample_sizes["all|all|all"]?.matches;

  const stats: [string, string, string][] = [
    ["Matches analysed", phase1 ? millions(phase1) : "–", meta ? `hero power curves, last ${meta.days} days` : "hero power curves"],
    ["Winner picked at minute 30", at(30) != null ? pct(at(30)!, 0) : "–", "on a day the model never saw"],
    ["Winner picked at minute 3", at(3) != null ? pct(at(3)!, 0) : "–", "mostly from the draft and the players"],
    ["Calibration error", ece != null ? pct(ece, 1) : "–", "a 70% call wins about 70% of the time"],
  ];

  return (
    <>
      <h1>About this project</h1>
      <p className="lede">
        Deadlock is Valve's 6v6 hero shooter. This site asks two questions of millions of public matches: which heroes
        get stronger as a game goes on, and who is going to win a game from any moment in it. It is a portfolio project
        by <a href={AUTHOR.linkedin} target="_blank" rel="noopener noreferrer">{AUTHOR.name}</a>, inspired by statistics
        videos about Dota 2.
      </p>

      <div className="tiles">
        {stats.map(([label, value, sub]) => (
          <div key={label} className="tile"><div className="label">{label}</div><div className="value">{value}</div><div className="sub">{sub}</div></div>
        ))}
      </div>

      <div className="about-grid">
        <div className="card">
          <h2>What you can do here</h2>
          <ul className="about-list">
            <li><Link to="/findings">Findings</Link>: the whole project as one short read, with the main charts. Start here.</li>
            <li><Link to="/">Heroes</Link> and <Link to="/power-curves">All power curves</Link>: each hero's win rate by game
              length, with 95% confidence intervals, filterable by patch, queue and rank.</li>
            <li><Link to="/scaling">Scaling index</Link>: which heroes win long games and which win short ones, adjusted so
              that strong heroes winning stomps doesn't count as "early-game".</li>
            <li><Link to="/what-wins">What wins games</Link>: how much each factor (souls, kills, objectives, the draft,
              the players' history) is worth at each minute.</li>
            <li><Link to="/win-probability">Win probability</Link>: a minute-by-minute graph of who was winning, for any
              finished match, with objectives and kills on the timeline.</li>
            <li><Link to="/live">Live games</Link>: matches being played right now, and live tracking of any match by its ID.</li>
            <li><Link to="/model-check">Model check</Link>: how well the model does on matches it never saw, and every
              idea that was tested, including the ones that didn't help.</li>
          </ul>
        </div>

        <div className="card">
          <h2>How it works</h2>
          <ul className="about-list">
            <li><b>Data.</b> The Deadlock API's free public data lake: one row per player per match, with stat snapshots
              through the game. Queried with DuckDB, one day at a time, into small precomputed tables.</li>
            <li><b>Statistics.</b> Wilson intervals on every win rate, minimum sample sizes, and weighted slopes for the
              scaling index. Game length is treated as an outcome, not a clock.</li>
            <li><b>Model.</b> One gradient-boosted model for the whole game, with a per-minute logistic score as an input,
              both teams treated the same, and isotonic recalibration. 30 factors, including draft synergy, counters and
              30-day player history taken only from before each match.</li>
            <li><b>Honest testing.</b> Trained on earlier days and tested on the newest one, split by match, reported as
              log loss, Brier score and calibration. Ideas that didn't beat the baseline (a separate model per rank, for
              example) were dropped and are shown on the Model check page.</li>
            <li><b>No server.</b> The site is static, hosted free on GitHub Pages. Match lookups and live tracking run the
              exported model in your browser, checked against the Python pipeline to five decimal places.</li>
          </ul>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Built with</h2>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          Python (pandas, DuckDB, scikit-learn, FastAPI) · TypeScript, React and Vite, with hand-made SVG charts ·
          GitHub Actions and GitHub Pages · data from the <a href="https://deadlock-api.com" target="_blank" rel="noopener noreferrer">Deadlock API</a>.
          Not affiliated with Valve.
        </p>
      </div>

      <div className="card about-author" style={{ marginTop: 16 }}>
        <div>
          <h2>{AUTHOR.name}</h2>
          <p className="muted small" style={{ margin: "2px 0 0" }}>Designed, analysed and built the whole project, from data pipeline to website.</p>
        </div>
        <span className="links">
          <a className="btn" href={AUTHOR.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a>
          <a className="btn" href={AUTHOR.github} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a className="btn" href={REPO} target="_blank" rel="noopener noreferrer">Source code</a>
        </span>
      </div>
      {t && (
        <p className="muted small" style={{ marginTop: 12 }}>
          Model numbers: trained on {millions(t.matches_train)} matches, tested on {t.matches_test.toLocaleString()} matches
          from {t.test_day}.
        </p>
      )}
    </>
  );
}
