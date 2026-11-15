// Hero pairs explorer: any two heroes, together or against each other, and every pair
// at once as a matrix. Same numbers as the partners / match-ups lists on the hero pages
// (pipeline/hero_pairs.py), for the selected patch, queue and rank.
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { sliceQuery, useApi, type Hero, type HeroesResponse } from "../api";
import { PairLegend, PairMatrix, type PairCell } from "../charts/PairMatrix";
import { Loading } from "../components/ui";
import { FilterBar, useSlice, useSliceSearch } from "../filters";
import { int, pct } from "../format";

interface PairsResponse {
  first_day: string; last_day: string; min_games: number; cols: string[];
  heroes: Record<string, { with: number[][]; against: number[][] }>;
}
type Kind = "with" | "against";
const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

function PairTile({ title, c, a, verb }: { title: string; c?: PairCell; a: Hero; verb: string }) {
  return (
    <div className="tile card">
      <div className="label">{title}</div>
      {c ? (
        <>
          <div className="value">{signed(c.effect)} pp</div>
          <div className="sub">95% CI {signed(c.ci_low)} to {signed(c.ci_high)}</div>
          <div className="sub">{a.name}'s side won {pct(c.win_rate)}; {pct(c.expected)} expected from the two heroes' own win rates</div>
          <div className="sub">{int(c.n)} games {verb}</div>
        </>
      ) : (
        <><div className="value">–</div><div className="sub">Too few games in this slice</div></>
      )}
    </div>
  );
}

export function Pairs() {
  const [slice] = useSlice();
  const search = useSliceSearch();
  const [params, setParams] = useSearchParams();
  const heroes = useApi<HeroesResponse>(`heroes?${sliceQuery(slice)}`);
  const pairs = useApi<PairsResponse>(`hero-pairs?${sliceQuery(slice)}`);

  const list = useMemo(() => [...(heroes.data?.heroes ?? [])].filter((h) => h.games).sort((x, y) => x.name.localeCompare(y.name)), [heroes.data]);
  const byId = useMemo(() => new Map(list.map((h) => [h.id, h as Hero])), [list]);
  const table = useMemo(() => {
    const m = new Map<string, PairCell>();
    const d = pairs.data;
    if (!d) return m;
    const ix = (c: string) => d.cols.indexOf(c);
    for (const [hero, v] of Object.entries(d.heroes)) {
      for (const kind of ["with", "against"] as Kind[]) {
        for (const r of v[kind]) {
          m.set(`${hero}-${r[ix("other")]}-${kind}`, { n: r[ix("n")], win_rate: r[ix("win_rate")], expected: r[ix("expected")],
            effect: r[ix("effect")], ci_low: r[ix("ci_low")], ci_high: r[ix("ci_high")] });
        }
      }
    }
    return m;
  }, [pairs.data]);
  const cell = (a: number, b: number, kind: Kind) => table.get(`${a}-${b}-${kind}`);

  const kind: Kind = params.get("kind") === "against" ? "against" : "with";
  const aId = Number(params.get("a")) || list[0]?.id;
  const bId = Number(params.get("b")) || list[1]?.id;
  const a = aId != null ? byId.get(aId) : undefined, b = bId != null ? byId.get(bId) : undefined;
  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) p.set(k, v);
    setParams(p, { replace: true });
  };

  // the strongest pairs in this slice, for a quick read
  const top = (k: Kind, dir: 1 | -1) => [...table.entries()]
    .filter(([key]) => key.endsWith(`-${k}`))
    .map(([key, c]) => { const [h, o] = key.split("-").map(Number); return { h, o, c }; })
    .filter((x) => k === "against" || x.h < x.o)                  // "with" is listed both ways; show once
    .sort((x, y) => dir * (y.c.effect - x.c.effect))
    .slice(0, 3);
  const name = (id: number) => byId.get(id)?.name ?? `Hero ${id}`;

  return (
    <>
      <h1>Hero pairs</h1>
      <p className="lede">
        Which heroes work well together, and which beat each other? Pick any two heroes, or scan every pair in the
        matrix. The effect is how much more (or less) often a side wins than the two heroes' own win rates predict.
      </p>
      <FilterBar sample={heroes.data?.sample} range={pairs.data ? `${pairs.data.first_day} – ${pairs.data.last_day}` : undefined} />
      {(heroes.error || pairs.error) && <p className="error">{heroes.error ?? pairs.error}</p>}

      <Loading loading={heroes.loading || pairs.loading}>
        {list.length > 1 && a && b && (
          <div className="card" style={{ marginBottom: 16 }}>
            <form className="filters" style={{ marginBottom: 12 }} onSubmit={(e) => e.preventDefault()}>
              {([["a", "Hero", aId], ["b", "With or against", bId]] as const).map(([k, label, v]) => (
                <div className="filter" key={k}>
                  <label htmlFor={`pair-${k}`}>{label}</label>
                  <select id={`pair-${k}`} value={v} onChange={(e) => set({ [k]: e.target.value })}>
                    {list.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                </div>
              ))}
              <button type="button" className="btn" style={{ alignSelf: "end" }} onClick={() => set({ a: String(bId), b: String(aId) })}>Swap</button>
            </form>
            {aId === bId ? <p className="muted">Pick two different heroes.</p> : (
              <div className="tiles" style={{ marginBottom: 4 }}>
                <PairTile title={`${a.name} with ${b.name} (same team)`} c={cell(a.id, b.id, "with")} a={a} verb="together" />
                <PairTile title={`${a.name} against ${b.name}`} c={cell(a.id, b.id, "against")} a={a} verb="against each other" />
              </div>
            )}
            <p className="muted small" style={{ margin: "8px 0 0" }}>
              <Link to={`/heroes/${a.id}${search}`}>{a.name}'s page</Link> · <Link to={`/heroes/${b.id}${search}`}>{b.name}'s page</Link>
            </p>
          </div>
        )}

        {table.size > 0 && (
          <div className="tiles">
            {([["Best together", "with", 1], ["Worst together", "with", -1], ["Most one-sided match-ups", "against", 1]] as const).map(([title, k, dir]) => (
              <div className="tile card" key={title}>
                <div className="label">{title}</div>
                {top(k, dir).map(({ h, o, c }) => (
                  <div key={`${h}-${o}`} className="sub" style={{ marginTop: 4 }}>
                    <button className="linkish" onClick={() => set({ a: String(h), b: String(o), kind: k })}>
                      {name(h)} {k === "with" ? "+" : "vs"} {name(o)}
                    </button>{" "}
                    <span className="num">{signed(c.effect)} pp</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Every pair</h2>
              <span className="muted small">Row hero {kind === "with" ? "with" : "against"} column hero. Click a square to look at that pair.</span>
            </div>
            <div className="seg" role="group" aria-label="Pair type">
              <button aria-pressed={kind === "with"} onClick={() => set({ kind: "with" })}>Same team</button>
              <button aria-pressed={kind === "against"} onClick={() => set({ kind: "against" })}>Opposite teams</button>
            </div>
          </div>
          <PairLegend extent={2} />
          {list.length > 0 && (
            <PairMatrix heroes={list} kind={kind} extent={2} cell={(x, y) => cell(x, y, kind)}
              selected={aId != null && bId != null ? [aId, bId] : null}
              onSelect={(x, y) => { set({ a: String(x), b: String(y) }); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
          )}
        </div>
      </Loading>

      <p className="note">
        <span aria-hidden>ⓘ</span>
        <span>
          <b>How to read it.</b> Expected = 50% plus each hero's own win-rate edge (for opposite teams, one edge minus the
          other), measured in the same matches. Pairs need at least {pairs.data ? int(pairs.data.min_games) : "1,000"} games
          in the selected slice; matches where someone left are not counted. Most effects are within ±2 points: the draft
          matters, but no pair decides a game. With 900+ pairs, a few will look large by chance; check the interval.
        </span>
      </p>
    </>
  );
}
