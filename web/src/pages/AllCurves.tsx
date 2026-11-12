import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { sliceQuery, useApi, type CurvesResponse, type HeroesResponse, type IndexResponse } from "../api";
import { curveDomain, PowerCurve } from "../charts/PowerCurve";
import { DemoBanner, HeroAvatar, LengthCaveat, Loading, ThresholdNote } from "../components/ui";
import { FilterBar, useSlice, useSliceSearch } from "../filters";
import { pp } from "../format";

export function AllCurves() {
  const [slice] = useSlice();
  const search = useSliceSearch();
  const [order, setOrder] = useState<"scaling" | "name">("scaling");
  const curves = useApi<CurvesResponse>(`power-curves?${sliceQuery(slice)}`);
  const index = useApi<IndexResponse>(`scaling-index?${sliceQuery(slice)}`);
  const heroes = useApi<HeroesResponse>(`heroes?${sliceQuery(slice)}`);

  const byId = useMemo(() => new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h])), [heroes.data]);
  const scaling = useMemo(() => new Map((index.data?.heroes ?? []).map((r, i) => [r.hero_id, { ...r, pos: i }])), [index.data]);
  const list = useMemo(() => {
    const c = [...(curves.data?.curves ?? [])];
    const name = (id: number) => byId.get(id)?.name ?? `Hero ${id}`;
    return order === "name"
      ? c.sort((a, b) => name(a.hero_id).localeCompare(name(b.hero_id), undefined, { numeric: true }))
      : c.sort((a, b) => (scaling.get(a.hero_id)?.pos ?? 1e9) - (scaling.get(b.hero_id)?.pos ?? 1e9));
  }, [curves.data, order, byId, scaling]);
  // one shared y-axis so panels are comparable
  const domain = useMemo(() => curveDomain(list.flatMap((c) => c.points)), [list]);
  const loading = curves.loading || index.loading || heroes.loading;

  return (
    <>
      <h1>All power curves</h1>
      <p className="lede">
        Every hero's win rate by game length on one shared axis. Sorted most early-game first by default; heroes
        without enough games for a scaling index go last.
      </p>
      <DemoBanner />
      <FilterBar sample={curves.data?.sample} />
      <div className="filters">
        <div className="filter">
          <label htmlFor="order">Order</label>
          <select id="order" value={order} onChange={(e) => setOrder(e.target.value as "scaling" | "name")}>
            <option value="scaling">Early-game → late-game</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div className="sample"><ThresholdNote /></div>
      </div>
      <LengthCaveat />
      {curves.error && <p className="error">{curves.error}</p>}
      <Loading loading={loading}>
        <div className="multiples">
          {list.map((c) => {
            const h = byId.get(c.hero_id);
            const s = scaling.get(c.hero_id);
            const name = h?.name ?? `Hero ${c.hero_id}`;
            return (
              <div key={c.hero_id} className="card multiple">
                <Link to={`/heroes/${c.hero_id}${search}`} className="title">
                  <div><HeroAvatar src={h?.image ?? null} name={name} size={18} /> {name}</div>
                  <span>{s ? `${pp(s.pp_per_10min, 1)}/10m` : "–"}</span>
                </Link>
                <PowerCurve points={c.points} name={name} height={130} yDomain={domain} compact />
              </div>
            );
          })}
        </div>
      </Loading>
    </>
  );
}
