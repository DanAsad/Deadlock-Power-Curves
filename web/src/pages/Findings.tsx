// Findings: the project as one readable story (question → data → what was learned → limits).
// Every chart reads the same files as the other pages, so it stays current after the weekly refresh;
// numbers quoted in the text that come from one-off checks say so.
import { Link } from "react-router-dom";
import { useApi, type CurvesResponse, type HeroesResponse, type IndexResponse } from "../api";
import { ItemScatter, SlotLegend, type ItemPoint } from "../charts/ItemScatter";
import { LossLines } from "../charts/LossLines";
import { PowerCurve, curveDomain } from "../charts/PowerCurve";
import { ScalingBars } from "../charts/ScalingBars";
import { WinProb, type WpEvent, type WpPoint } from "../charts/WinProb";
import { Loading } from "../components/ui";
import { useMeta } from "../filters";
import { pct } from "../format";
import { AUTHOR } from "./About";

const ALL = "queue=all&rank=all&period=all";
const TEAMS: [string, string] = ["Hidden King", "Archmother"];

interface Scores { accuracy: number }
interface EvalLite { splits: Record<string, { test_day: string | null; matches_test: number; minutes: { minute: number; models: Record<string, Scores> }[] }> }
interface ItemsLite { cols: string[]; rows: (number | null)[][]; items: { id: number; name: string; slot: string | null }[] }
interface MatchResponse { match: { match_id: number; duration_s: number; winner: number; points: WpPoint[]; events: WpEvent[] } }

const millions = (n: number) => `${(n / 1e6).toFixed(1)} million`;

function Figure({ title, caption, children }: { title: string; caption: React.ReactNode; children: React.ReactNode }) {
  return (
    <figure className="card essay-figure">
      <h3 className="sub-h">{title}</h3>
      {children}
      <figcaption className="muted small">{caption}</figcaption>
    </figure>
  );
}

export function Findings() {
  const meta = useMeta();
  const heroes = useApi<HeroesResponse>(`heroes?${ALL}`);
  const index = useApi<IndexResponse>(`scaling-index?${ALL}`);
  const ev = useApi<EvalLite>("model-eval");
  // the "Comeback" example on the Win probability page (re-picked from each new held-out day)
  const list = useApi<{ matches: { match_id: number; label: string }[] }>("win-probability");
  const COMEBACK = (list.data?.matches.find((x) => x.label === "Comeback") ?? list.data?.matches[0])?.match_id;
  const match = useApi<MatchResponse>(COMEBACK != null ? `win-probability/${COMEBACK}` : null);
  const items = useApi<ItemsLite>(`items?${ALL}`);
  const byId = new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h]));
  const name = (id: number | undefined) => (id != null ? byId.get(id)?.name : undefined) ?? "–";

  // the strongest late-game and early-game heroes, by the adjusted scaling index
  const ranked = [...(index.data?.heroes ?? [])].sort((a, b) => b.pp_per_10min - a.pp_per_10min);
  const late = ranked[0], early = ranked[ranked.length - 1];
  const bars = ranked.length > 10 ? [...ranked.slice(0, 5), ...ranked.slice(-5)] : ranked;
  const curves = useApi<CurvesResponse>(late && early ? `power-curves?${ALL}&hero_id=${late.hero_id}&hero_id=${early.hero_id}` : null);
  const curveOf = (id?: number) => curves.data?.curves.find((c) => c.hero_id === id)?.points ?? [];
  const domain = curveDomain([...curveOf(late?.hero_id), ...curveOf(early?.hero_id)]);

  // how often each way of calling the winner is right, minute by minute (held-out day)
  const t = ev.data?.splits.time;
  const line = (key: string) => (t?.minutes ?? []).filter((m) => m.models[key]).map((m) => ({ x: m.minute, y: m.models[key].accuracy }));
  const at = (m: number) => t?.minutes.find((x) => x.minute === m)?.models.unified?.accuracy;
  const soulsAt = (m: number) => t?.minutes.find((x) => x.minute === m)?.models.souls_only?.accuracy;

  // items: raw edge of the buyers vs the edge left after comparing with the same hero in the same game state
  const itemPts: ItemPoint[] = (() => {
    const d = items.data;
    if (!d) return [];
    const ix = (c: string) => d.cols.indexOf(c);
    const info = new Map(d.items.map((x) => [x.id, x]));
    return d.rows.map((r) => {
      const id = r[ix("item_id")] as number, it = info.get(id);
      return { id, name: it?.name ?? String(id), slot: it?.slot ?? "", raw: ((r[ix("win_rate")] as number) - 0.5) * 100,
               effect: r[ix("effect")] as number, n: r[ix("n")] as number };
    });
  })();
  const avg = (f: (p: ItemPoint) => number) => itemPts.length ? itemPts.reduce((a, p) => a + Math.abs(f(p)), 0) / itemPts.length : 0;
  const bestItems = [...itemPts].sort((a, b) => b.effect - a.effect).slice(0, 3);
  const m = match.data?.match;
  const low = m ? Math.min(...m.points.map((p) => (m.winner === 0 ? p.p : 1 - p.p))) : null;
  const matches = meta?.sample_sizes["all|all|all"]?.matches;

  return (
    <article className="essay">
      <p className="kicker muted small">Findings · by <Link to="/about">{AUTHOR.name}</Link></p>
      <h1>Who scales, and who's winning? What {matches ? millions(matches) : "millions of"} Deadlock matches say</h1>
      <p className="lede">
        Deadlock is Valve's 6v6 hero shooter. Players argue endlessly about which heroes "scale" into the late game and
        which ones have to win early. This project measures it, and then goes one step further: a model that says
        who is going to win from any moment of a match, tested on games it never saw.
      </p>

      <section>
        <h2>1. The data</h2>
        <p>
          Every public match from the free <a href="https://deadlock-api.com" target="_blank" rel="noopener noreferrer">Deadlock API</a> data
          lake: one row per player per match, with stat snapshots (souls, kills, damage, objectives) every few minutes.
          The last {meta?.days ?? 30} days come to {matches ? millions(matches) : "several million"} matches for the hero curves. Queries run
          in DuckDB one day at a time, so the whole pipeline fits on a laptop, and the results are small tables that a
          static website can serve. The tables are rebuilt every week.
        </p>
      </section>

      <section>
        <h2>2. Short games are mostly someone leaving</h2>
        <p>
          The first chart anyone draws is win rate against game length. Before reading it, look at <i>why</i> games end
          early. When this project checked (13 Nov 2026), <b>86% of games under 20 minutes had a player who
          abandoned</b>, and the team with the leaver won only <b>0.2%</b> of them. Those games say nothing about heroes,
          only about who disconnected.
        </p>
        <p>
          So matches with a leaver are left out
          {meta?.leaver_share != null && <> ({pct(meta.leaver_share, 1)} of all matches{meta.leaver_matches_excluded ? `, ${meta.leaver_matches_excluded.toLocaleString()} games` : ""})</>}.
          A strange jump between the under-20 and 20–25 minute buckets, which had tracked each hero's overall strength
          almost perfectly (correlation 0.88), dropped to nothing (0.08).
        </p>
      </section>

      <section>
        <h2>3. Game length is an outcome, not a clock</h2>
        <p>
          The obvious "scaling" score is the slope of win rate against game length. It is misleading: strong heroes win
          more stomps, and stomps end early, so a strong hero's curve slopes down even if the hero is just as good at
          minute 40. Across heroes, that plain slope correlated <b>−0.80</b> with overall win rate.
        </p>
        <p>
          The fix compares each hero with what its overall strength alone would predict in each length bucket, and
          measures the slope of what is left. That correlation drops to <b>0.01</b>: the score now measures scaling,
          not strength. Each point below is a Wilson 95% interval, and buckets with fewer than {meta?.min_games_per_bin ?? 300} games are hidden.
        </p>
        <Figure
          title={late && early ? `Most late-game vs most early-game hero: ${name(late.hero_id)} and ${name(early.hero_id)}` : "Most late-game vs most early-game hero"}
          caption={<>Win rate by game length, all queues and ranks, leaver matches excluded. Shaded: 95% confidence interval. <Link to="/power-curves">Every hero →</Link></>}>
          <Loading loading={curves.loading || index.loading}>
            <div className="pair-grid">
              {[late, early].map((r) => r && (
                <div key={r.hero_id}>
                  <p className="small" style={{ margin: "0 0 4px" }}><b>{name(r.hero_id)}</b> <span className="muted">· scaling index {r.pp_per_10min > 0 ? "+" : ""}{r.pp_per_10min.toFixed(1)} pp per 10 min</span></p>
                  <PowerCurve points={curveOf(r.hero_id)} name={name(r.hero_id)} height={220} yDomain={domain} />
                </div>
              ))}
            </div>
          </Loading>
        </Figure>
        <Figure
          title="The five most late-game and five most early-game heroes"
          caption={<>Scaling index: change in win rate per extra 10 minutes of game, adjusted for hero strength, with 95% intervals. <Link to="/scaling">Every hero, by patch, queue and rank →</Link></>}>
          <Loading loading={index.loading || heroes.loading}>
            {bars.length > 0 && <ScalingBars rows={bars} heroes={byId} linkSearch="" />}
          </Loading>
        </Figure>
      </section>

      <section>
        <h2>4. Does rank change who scales?</h2>
        <p>
          Mostly no. Splitting ranked games into three brackets, the scaling index at low and high ranks correlates about
          0.83 across heroes: the same heroes scale everywhere. A few move a lot. In the 30 days checked (13 Nov 2026),
          Dynamo went from slightly early-game at low ranks to clearly late-game at high ranks, and Lady Geist became
          more early-game. <Link to="/scaling?by=rank">Compare every hero by rank →</Link>
        </p>
      </section>

      <section>
        <h2>5. What wins games changes with the clock</h2>
        <p>
          A soul lead matters more the longer a game goes. At minute 3, the team ahead on souls wins only a little more
          than half the time; by minute 30 a souls-only model picks the winner {soulsAt(30) != null ? pct(soulsAt(30)!, 0) : "about 78%"} of the
          time. Objectives that open the enemy base are tied to wins even more strongly: at minute 30 the team that has
          taken more Shrines wins about 91% of its games, against 79% for the team ahead on souls. And a teammate leaving
          outweighs almost anything else.
        </p>
        <p>
          The full model adds the draft (hero strength, pairs that work together, counters), every player's 30-day
          history from <i>before</i> the match, kills, damage, deaths and respawn timers, and the objectives. Its edge over
          souls alone is biggest at the start, when the soul lead says little and the draft and the players carry the
          prediction (about 6 points of accuracy at minute 3 come from pre-game information alone), and again in long
          games, when objectives and respawn timers decide fights.
        </p>
        <Figure
          title="How often the winner is called correctly, minute by minute"
          caption={<>Matches from {t?.test_day ?? "a later day"} that the models never saw ({t ? t.matches_test.toLocaleString() : "–"} matches). <Link to="/what-wins">Each factor, minute by minute →</Link></>}>
          <Loading loading={ev.loading}>
            {t && <div className="legend">
              <span><i className="ln" style={{ background: "var(--series)" }} />Full model</span>
              <span><i className="ln" style={{ background: "var(--cat-2)" }} />Soul lead only</span>
            </div>}
            {t && (
              <LossLines
                height={240}
                yLabel="Winner called correctly"
                format={(v) => pct(v, 0)}
                reference={{ y: 0.5, label: "coin flip" }}
                series={[
                  { id: "unified", label: "Full model", color: "var(--series)", points: line("unified") },
                  { id: "souls_only", label: "Soul lead only", color: "var(--cat-2)", points: line("souls_only") },
                ]}
              />
            )}
          </Loading>
        </Figure>
      </section>

      <section>
        <h2>6. Items: most of an item's win rate is being ahead</h2>
        <p>
          Item win rates are the next obvious chart, and they have the same problem as short games: the team that is
          ahead has more souls, so it buys more items, so almost every item "wins". Comparing each purchase with the
          same hero in the same game state (the team's soul lead and the minute it was bought) shrinks the average
          item edge from {avg((p) => p.raw).toFixed(1)} to {avg((p) => p.effect).toFixed(1)} percentage points.
          {bestItems.length > 0 && <> What is left still separates items: the biggest effects are {bestItems.map((b, i) => (
            <span key={b.id}>{i ? (i === bestItems.length - 1 ? " and " : ", ") : ""}<b>{b.name}</b> ({b.effect > 0 ? "+" : ""}{b.effect.toFixed(1)})</span>))}.
            Part of what is left is still who buys: the adjustment uses the team's soul lead, not the buyer's own souls,
            so expensive items keep a small edge from being bought by well-farmed players.</>}
        </p>
        <Figure
          title="Raw vs adjusted, every item"
          caption={<>Each point is an item: across, the buyers' win rate minus 50%; up, the edge left after the adjustment. On the dashed line nothing would change. <Link to="/items">Every item, by slot, tier and purchase time →</Link></>}>
          <Loading loading={items.loading}>
            {itemPts.length > 0 && <><SlotLegend /><ItemScatter points={itemPts} height={340} /></>}
          </Loading>
        </Figure>
      </section>

      <section>
        <h2>7. A win-probability graph for any match</h2>
        <p>
          The model gives a win chance at every minute, which turns any match into a story. It picks the winner{" "}
          {at(3) != null ? pct(at(3)!, 0) : "65%"} of the time at minute 3, {at(15) != null ? pct(at(15)!, 0) : "72%"} at minute 15 and{" "}
          {at(30) != null ? pct(at(30)!, 0) : "82%"} at minute 30. More importantly, it is <b>calibrated</b>: when it says
          70%, that side wins about 70% of the time, so the line can be read as a real probability.
        </p>
        <Figure
          title={low != null ? `A comeback: the winner's chance fell ${low < 0.01 ? "below 1%" : `to ${pct(low, 0)}`}` : "A comeback"}
          caption={<>Each point is the model's win chance at that minute; letters mark objectives. <Link to={`/win-probability?match=${COMEBACK}`}>Open this match, or look up any other →</Link></>}>
          <Loading loading={match.loading}>
            {m && <WinProb points={m.points} events={m.events} durationS={m.duration_s} winner={m.winner} teams={TEAMS} showLive={false} />}
          </Loading>
        </Figure>
        <p>
          The same model runs in the browser, so the <Link to="/live">Live games</Link> page can follow a match while it
          is being played, reading its live broadcast every 30 seconds. The browser version matches the Python
          pipeline to five decimal places, and a test checks that on every change.
        </p>
      </section>

      <section>
        <h2>8. What didn't work (and why that matters)</h2>
        <ul>
          <li>
            <b>Filling in stats between snapshots leaked the future.</b> Stats are recorded every few minutes. Drawing a
            straight line between snapshots made the model look better just after a snapshot than at one, because the
            line already "knew" the next value. Carrying the last value forward, with an input for how old it is,
            fixed it.
          </li>
          <li>
            <b>More models weren't better.</b> Separate models for ranked and unranked, and for each rank bracket, were
            each tested against the one shared model. None beat it, and the narrower the group, the worse its own model
            did. The shared model stayed. Every one of these tests is on the <Link to="/model-check">Model check</Link> page.
          </li>
          <li>
            <b>Testing is split by match and by time.</b> The model is trained on earlier days and scored on the newest
            day, so no match is in both sets, and the score shows how it will do on games that haven't been played yet.
          </li>
        </ul>
      </section>

      <section>
        <h2>9. Limits</h2>
        <ul>
          <li>These are the public matches the Deadlock API recorded, not every game played.</li>
          <li>Win rate by game length describes games that <i>lasted</i> that long. It is not a hero's strength at that minute; the hero pages also show the soul lead at fixed minutes for that.</li>
          <li>Pair and counter effects are small (mostly within ±2 percentage points) and shrunk toward zero when there are few games.</li>
          <li>Live win chances use what the broadcast sends; the list of live games uses only team souls and objectives, so it is rougher.</li>
        </ul>
      </section>

      <section className="card essay-end">
        <p style={{ margin: 0 }}>
          Built by <a href={AUTHOR.linkedin} target="_blank" rel="noopener noreferrer">{AUTHOR.name}</a>: data pipeline,
          statistics, model and website. Python (DuckDB, pandas, scikit-learn), TypeScript and React, hosted free on
          GitHub Pages. <Link to="/about">More about the project</Link> ·{" "}
          <a href="https://github.com/DanAsad/Deadlock-Power-Curves" target="_blank" rel="noopener noreferrer">source code</a>.
        </p>
      </section>
    </article>
  );
}
