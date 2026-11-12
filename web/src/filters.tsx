// Filter state lives in the URL (?queue=&rank=&period=) so every page, link
// and refresh shares the same slice.
import { createContext, useContext } from "react";
import { useSearchParams } from "react-router-dom";
import type { Meta, Sample, Slice } from "./api";
import { date, int } from "./format";

export const MetaContext = createContext<Meta | null>(null);
export const useMeta = () => useContext(MetaContext);

export function useSlice(): [Slice, (patch: Partial<Slice>) => void] {
  const [params, setParams] = useSearchParams();
  const slice: Slice = {
    queue: params.get("queue") ?? "all",
    rank: params.get("rank") ?? "all",
    period: params.get("period") ?? "all",
  };
  const update = (patch: Partial<Slice>) => {
    const next = { ...slice, ...patch };
    if (patch.rank && patch.rank !== "all") next.queue = "ranked";   // rank only exists for ranked
    if (patch.queue && patch.queue !== "ranked") next.rank = "all";
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v === "all" ? p.delete(k) : p.set(k, v);
    setParams(p, { replace: true });
  };
  return [slice, update];
}

/** Keeps the current filters when navigating between pages. */
export function useSliceSearch(): string {
  const [params] = useSearchParams();
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function FilterBar({ sample, range }: { sample?: Sample | null; range?: string }) {
  const meta = useMeta();
  const [slice, update] = useSlice();
  if (!meta) return null;
  const f = meta.filters;
  return (
    <div className="filters" role="group" aria-label="Filters">
      <Select label="Patch" value={slice.period} options={f.period} onChange={(v) => update({ period: v })}
              disabled={f.period.length < 2} title={f.period.length < 2 ? "Add patch dates in pipeline/config.py" : undefined} />
      <Select label="Queue" value={slice.queue} options={f.queue} onChange={(v) => update({ queue: v })} />
      <Select label="Rank (ranked only)" value={slice.rank} options={f.rank} onChange={(v) => update({ rank: v })} />
      <div className="sample">
        {sample ? <><b className="num">{int(sample.matches)}</b> matches</> : "No matches in this slice"}
        <br />
        {range ?? `${date(meta.first_match)} – ${date(meta.last_match)}`}
      </div>
    </div>
  );
}

function Select(props: {
  label: string; value: string; options: { id: string; label: string }[];
  onChange: (v: string) => void; disabled?: boolean; title?: string;
}) {
  const id = `f-${props.label.split(" ")[0].toLowerCase()}`;
  return (
    <div className="filter" title={props.title}>
      <label htmlFor={id}>{props.label}</label>
      <select id={id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}
