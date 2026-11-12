import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { sliceQuery, useApi, type HeroesResponse, type IndexResponse } from "../api";
import { ScalingBars } from "../charts/ScalingBars";
import { DemoBanner, LengthCaveat, Loading, ViewToggle } from "../components/ui";
import { FilterBar, useMeta, useSlice, useSliceSearch } from "../filters";
import { int, pct, pp } from "../format";

export function ScalingIndex() {
  const [slice] = useSlice();
  const search = useSliceSearch();
  const meta = useMeta();
  const [view, setView] = useState<"chart" | "table">("chart");
  const index = useApi<IndexResponse>(`scaling-index?${sliceQuery(slice)}`);
  const heroes = useApi<HeroesResponse>(`heroes?${sliceQuery(slice)}`);
  const byId = useMemo(() => new Map((heroes.data?.heroes ?? []).map((h) => [h.id, h])), [heroes.data]);
  const rows = index.data?.heroes ?? [];

  return (
    <>
      <h1>Scaling index</h1>
      <p className="lede">
        Who gets stronger the longer the game goes? Percentage points of win rate gained per extra 10 minutes of
        game length: an inverse-variance weighted slope through each hero's power curve, fit only on buckets with
        at least {meta?.min_games_per_bin.toLocaleString() ?? "–"} games.
      </p>
      <DemoBanner />
      <FilterBar sample={index.data?.sample} />
      <LengthCaveat />
      {index.error && <p className="error">{index.error}</p>}
      <Loading loading={index.loading || heroes.loading}>
        <div className="card">
          <div className="card-head">
            <div className="legend" style={{ margin: 0 }}>
              <span><i className="sw" style={{ background: "var(--early)" }} />Early-game (wins short games)</span>
              <span><i className="sw" style={{ background: "var(--series)" }} />Late-game (wins long games)</span>
              <span><i className="ln" style={{ background: "var(--ink-2)", height: 1 }} />95% CI</span>
              <span><i className="sw" style={{ background: "var(--ink-2)", opacity: 0.4 }} />Faded: CI includes 0</span>
            </div>
            <ViewToggle value={view} onChange={setView} />
          </div>
          {view === "chart" ? (
            <ScalingBars rows={rows} heroes={byId} linkSearch={search} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Hero</th><th>pp / 10 min</th><th>95% CI</th><th>Win rate</th><th>Games</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.hero_id}>
                      <td><Link to={`/heroes/${r.hero_id}${search}`}>{byId.get(r.hero_id)?.name ?? `Hero ${r.hero_id}`}</Link></td>
                      <td>{pp(r.pp_per_10min)}</td><td>{pp(r.ci_low)} to {pp(r.ci_high)}</td>
                      <td>{pct(r.win_rate)}</td><td>{int(r.games)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Loading>
    </>
  );
}
