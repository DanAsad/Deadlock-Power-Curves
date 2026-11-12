import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { sliceQuery, useApi, type HeroesResponse, type Interval } from "../api";
import { DemoBanner, Loading } from "../components/ui";
import { FilterBar, useSlice, useSliceSearch } from "../filters";
import { compact, int, pct, pp } from "../format";

/** Early / late only when the 95% CI excludes zero. */
function ScalingTag({ s }: { s: Interval }) {
  const kind = s.ci_high < 0 ? "Early" : s.ci_low > 0 ? "Late" : "No clear trend";
  const color = kind === "Early" ? "var(--early)" : kind === "Late" ? "var(--series)" : "var(--axis)";
  return (
    <span className="tag" title={`Win rate change per extra 10 min of game length (95% CI ${pp(s.ci_low, 1)} to ${pp(s.ci_high, 1)})`}>
      <i style={{ background: color }} />{kind} · {pp(s.pp_per_10min, 1)}/10m
    </span>
  );
}

type Sort = "name" | "win_rate" | "scaling" | "games";

export function HeroGrid() {
  const [slice] = useSlice();
  const search = useSliceSearch();
  const { data, error, loading } = useApi<HeroesResponse>(`heroes?${sliceQuery(slice)}`);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("name");

  const heroes = useMemo(() => {
    const list = (data?.heroes ?? []).filter((h) => h.games && h.name.toLowerCase().includes(q.toLowerCase()));
    const key: Record<Sort, (h: (typeof list)[number]) => number | string> = {
      name: (h) => h.name,
      win_rate: (h) => -(h.win_rate ?? 0),
      scaling: (h) => h.scaling?.pp_per_10min ?? 99,
      games: (h) => -(h.games ?? 0),
    };
    const cmp = (u: number | string, v: number | string) =>
      typeof u === "string" ? u.localeCompare(String(v), undefined, { numeric: true }) : u - (v as number);
    return [...list].sort((a, b) => cmp(key[sort](a), key[sort](b)));
  }, [data, q, sort]);

  return (
    <>
      <h1>Heroes</h1>
      <p className="lede">Pick a hero to see how its win rate changes with game length.</p>
      <DemoBanner />
      <FilterBar sample={data?.sample} />
      <div className="filters">
        <div className="filter">
          <label htmlFor="hero-search">Search</label>
          <input id="hero-search" className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hero name" />
        </div>
        <div className="filter">
          <label htmlFor="hero-sort">Sort by</label>
          <select id="hero-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="name">Name</option>
            <option value="win_rate">Win rate</option>
            <option value="scaling">Most early-game first</option>
            <option value="games">Games played</option>
          </select>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <Loading loading={loading}>
        <div className="hero-grid">
          {heroes.map((h) => (
            <Link key={h.id} to={`/heroes/${h.id}${search}`} className="hero-card">
              <div className="art">
                {h.card ? <img src={h.card} alt="" loading="lazy" /> : <span className="ph">{h.name.replace(/^Hero /, "")}</span>}
              </div>
              <div className="meta">
                <div className="name">{h.name}</div>
                <div className="stats">
                  <span className="num">{h.win_rate != null ? pct(h.win_rate) : "–"} WR</span>
                  <span className="num" title={h.games != null ? `${int(h.games)} games` : undefined}>{h.games != null ? compact(h.games) : "–"} games</span>
                </div>
                {h.scaling && <ScalingTag s={h.scaling} />}
              </div>
            </Link>
          ))}
        </div>
      </Loading>
    </>
  );
}
