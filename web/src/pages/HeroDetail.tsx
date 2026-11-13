import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { sliceQuery, useApi, type CurvesResponse, type HeroesResponse, type IndexResponse } from "../api";
import { PowerCurve } from "../charts/PowerCurve";
import { HeroAtMinute, HeroPairs } from "../components/HeroExtras";
import { DemoBanner, LengthCaveat, Loading, ThresholdNote, ViewToggle } from "../components/ui";
import { FilterBar, useMeta, useSlice, useSliceSearch } from "../filters";
import { int, pct, pp } from "../format";

export function HeroDetail() {
  const id = Number(useParams().heroId);
  const [slice] = useSlice();
  const search = useSliceSearch();
  const meta = useMeta();
  const [view, setView] = useState<"chart" | "table">("chart");

  const heroes = useApi<HeroesResponse>(`heroes?${sliceQuery(slice)}`);
  const curves = useApi<CurvesResponse>(`power-curves?${sliceQuery(slice, { hero_id: id })}`);
  const index = useApi<IndexResponse>(`scaling-index?${sliceQuery(slice)}`);

  const hero = heroes.data?.heroes.find((h) => h.id === id);
  const points = curves.data?.curves.find((c) => c.hero_id === id)?.points ?? [];
  const row = index.data?.heroes.find((h) => h.hero_id === id);
  const rankPos = row && index.data ? index.data.heroes.indexOf(row) + 1 : null;
  const loading = heroes.loading || curves.loading || index.loading;
  const error = heroes.error || curves.error || index.error;
  const name = hero?.name ?? `Hero ${id}`;
  const byId = new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h]));

  return (
    <>
      <Link to={`/${search}`} className="back">← All heroes</Link>
      <div className="detail-head">
        {hero?.image && <img src={hero.image} alt="" />}
        <div>
          <h1>{name}</h1>
          <p className="lede" style={{ margin: 0 }}>Win rate by game length, strength at each minute, partners and match-ups</p>
        </div>
      </div>
      <DemoBanner />
      <FilterBar sample={curves.data?.sample} />
      {error && <p className="error">{error}</p>}
      <Loading loading={loading}>
        <div className="tiles">
          <div className="card tile">
            <div className="label">Win rate</div>
            <div className="value">{row ? pct(row.win_rate) : hero?.win_rate != null ? pct(hero.win_rate) : "–"}</div>
            <div className="sub">{row ? `95% CI ${pct(row.wr_ci_low)} – ${pct(row.wr_ci_high)}` : " "}</div>
          </div>
          <div className="card tile">
            <div className="label">Games</div>
            <div className="value">{hero?.games != null ? int(hero.games) : "–"}</div>
            <div className="sub">player-games in this slice</div>
          </div>
          <div className="card tile">
            <div className="label">Scaling index</div>
            <div className="value">{row ? `${pp(row.pp_per_10min, 1)}` : "–"}</div>
            <div className="sub">
              {row ? <>per extra 10 min · 95% CI {pp(row.ci_low, 1)} to {pp(row.ci_high, 1)}</>
                   : `needs ${meta?.min_bins_for_index ?? 3}+ buckets with enough games`}
            </div>
          </div>
          <div className="card tile">
            <div className="label">Rank among heroes</div>
            <div className="value">{rankPos ? `#${rankPos}` : "–"}</div>
            <div className="sub">{rankPos ? `of ${index.data!.heroes.length}, most early-game = #1` : " "}</div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Win rate by game length</h2>
              <ThresholdNote />
            </div>
            <ViewToggle value={view} onChange={setView} />
          </div>
          {view === "chart" ? (
            <>
              <div className="legend">
                <span><i className="ln" style={{ background: "var(--series)" }} />Win rate</span>
                <span><i className="bd" style={{ background: "var(--band)" }} />95% CI</span>
                <span><i className="ln" style={{ background: "var(--axis)" }} />50%</span>
              </div>
              <PowerCurve points={points} name={name} height={340} />
            </>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Game length</th><th>Win rate</th><th>95% CI</th><th>Wins</th><th>Games</th><th>Shown</th></tr></thead>
                <tbody>
                  {points.map((p) => (
                    <tr key={p.bucket_idx} className={p.enough ? "" : "dim"}>
                      <td>{p.bucket} min</td><td>{pct(p.win_rate)}</td>
                      <td>{pct(p.ci_low)} – {pct(p.ci_high)}</td>
                      <td>{int(p.wins)}</td><td>{int(p.games)}</td>
                      <td>{p.enough ? "yes" : "no: too few games"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Loading>
      <div style={{ marginTop: 16 }}><LengthCaveat /></div>
      <HeroAtMinute id={id} name={name} slice={slice} />
      <HeroPairs id={id} name={name} heroes={byId} search={search} />
    </>
  );
}
