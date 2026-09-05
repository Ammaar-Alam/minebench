"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { LeaderboardResponse } from "@/lib/arena/types";
import {
  formatEfficiencyResource,
  getEfficiencyAxisDomain,
  getEfficiencyPoints,
  getEfficiencyResource,
  getParetoFrontier,
  getResourcePerScore,
  type EfficiencyMetric,
} from "@/lib/leaderboardEfficiency";
import { matchesLeaderboardModelQuery } from "@/lib/leaderboardSearch";

const METRICS = [
  { key: "cost", label: "Cost", resource: "Cost per build" },
  { key: "speed", label: "Speed", resource: "Time per build" },
  { key: "blocks", label: "Blocks", resource: "Blocks per build" },
] as const;
const HEIGHT = 340;
const PAD = { left: 52, right: 28, top: 34, bottom: 54 };
const numeric = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function LeaderboardEfficiency({ models, modelQuery }: {
  models: LeaderboardResponse["models"];
  modelQuery: string;
}) {
  const headingId = useId();
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [metric, setMetric] = useState<EfficiencyMetric>("cost");
  const [establishedOnly, setEstablishedOnly] = useState(false);
  const [logScale, setLogScale] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [perScore, setPerScore] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: EfficiencyMetric | "rating"; descending: boolean }>({ key: "cost", descending: false });
  const config = METRICS.find((item) => item.key === metric)!;
  const measured = useMemo(() => getEfficiencyPoints(models, metric), [models, metric]);
  const points = useMemo(() => getEfficiencyPoints(models, metric, establishedOnly), [models, metric, establishedOnly]);
  const frontier = useMemo(() => getParetoFrontier(points), [points]);
  const frontierKeys = new Set(frontier.map((point) => point.model.key));
  const selected = points.find((point) => point.model.key === selectedKey) ?? frontier.at(-1) ?? null;
  const canUseLog = points.length > 0 && points.every((point) => point.resource > 0);
  const useLog = logScale && canUseLog;
  const [xMin, xMax] = getEfficiencyAxisDomain(points.map((point) => point.resource), useLog);
  const [yMin, yMax] = getEfficiencyAxisDomain(points.map((point) => point.model.rankScore));
  const x = (value: number) => PAD.left + ((useLog ? Math.log10(value) : value) - xMin) / (xMax - xMin) * (width - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (yMax - value) / (yMax - yMin) * (HEIGHT - PAD.top - PAD.bottom);
  const valueFor = (model: LeaderboardResponse["models"][number], key: EfficiencyMetric) => {
    const resource = getEfficiencyResource(model, key);
    return perScore ? getResourcePerScore(resource, model.meanScore) : resource;
  };
  const rows = points.map((point) => point.model).filter((model) =>
    matchesLeaderboardModelQuery(model, modelQuery),
  ).sort((a, b) => {
    const av = sort.key === "rating" ? a.rankScore : valueFor(a, sort.key);
    const bv = sort.key === "rating" ? b.rankScore : valueFor(b, sort.key);
    if (av == null || bv == null) return av == null ? bv == null ? a.rank - b.rank : 1 : -1;
    return (sort.descending ? bv - av : av - bv) || a.rank - b.rank;
  });
  const sortBy = (key: typeof sort.key) => {
    setSort((current) => ({ key, descending: current.key === key ? !current.descending : key === "rating" }));
    if (key !== "rating") setMetric(key);
  };

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section aria-labelledby={headingId} className="mb-efficiency-enter min-w-0 pb-5">
      <h2 id={headingId} className="sr-only">Model efficiency</h2>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div role="group" aria-label="Efficiency metric" className="mb-leaderboard-switch">
          {METRICS.map((item) => (
            <button key={item.key} type="button" aria-pressed={metric === item.key}
              onClick={() => { setMetric(item.key); setSort({ key: item.key, descending: false }); }}
              className="mb-leaderboard-option">
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-5 text-xs text-muted sm:text-sm">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap">
            <input type="checkbox" checked={establishedOnly} onChange={(event) => setEstablishedOnly(event.target.checked)} className="h-3.5 w-3.5 accent-accent" />
            Established only
          </label>
          <label className={`inline-flex min-h-11 items-center gap-2 whitespace-nowrap ${canUseLog ? "cursor-pointer" : "opacity-50"}`}>
            <input type="checkbox" checked={useLog} disabled={!canUseLog} onChange={(event) => setLogScale(event.target.checked)} className="h-3.5 w-3.5 accent-accent" />
            Log scale
          </label>
        </div>
      </div>
      <div className="grid gap-6 pb-8 pt-5 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-8">
        <div className="min-w-0">
          <div ref={chartRef} className="relative min-w-0" onMouseLeave={() => setHoveredKey(null)}>
            <svg width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="group" aria-label={`${config.resource} versus rating`}>
              <title>{`${config.resource} versus rating; higher and further left is better`}</title>
              {[0, 1, 2, 3].map((index) => {
                const rating = yMin + (yMax - yMin) * index / 3;
                return <g key={index} className="text-border">
                  <line x1={PAD.left} x2={width - PAD.right} y1={y(rating)} y2={y(rating)} stroke="currentColor" strokeDasharray="3 5" />
                  <text x={PAD.left - 10} y={y(rating) + 4} textAnchor="end" className="fill-muted text-[11px] tabular-nums">{Math.round(rating)}</text>
                </g>;
              })}
              {[0, 1, 2].map((index) => {
                const value = xMin + (xMax - xMin) * index / 2;
                const resource = useLog ? 10 ** value : value;
                return <text key={index} x={x(resource)} y={HEIGHT - PAD.bottom + 22} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
                  {formatEfficiencyResource(resource, metric)}
                </text>;
              })}
              <text x={PAD.left} y={15} className="fill-muted text-[12px]">Rating ↑</text>
              <text x={width / 2} y={HEIGHT - 5} textAnchor="middle" className="fill-muted text-[12px]">← {config.resource}{useLog ? " · log scale" : ""}</text>
              {frontier.length > 1 ? <path key={`${metric}-${useLog}-${establishedOnly}`} className="mb-efficiency-frontier" fill="none" stroke="currentColor" strokeWidth={2}
                d={frontier.map((point, index) => `${index ? "L" : "M"}${x(point.resource)},${y(point.model.rankScore)}`).join(" ")} /> : null}
              {selected ? <g aria-hidden="true" className="text-muted/30" stroke="currentColor" strokeDasharray="3 5">
                <line x1={x(selected.resource)} x2={x(selected.resource)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
                <line x1={PAD.left} x2={width - PAD.right} y1={y(selected.model.rankScore)} y2={y(selected.model.rankScore)} />
              </g> : null}
              {points.map((point) => {
                const active = selected?.model.key === point.model.key;
                const onFrontier = frontierKeys.has(point.model.key);
                const matches = matchesLeaderboardModelQuery(point.model, modelQuery);
                const provisional = point.model.stability === "Provisional";
                const estimate = metric === "cost" && point.model.benchmark?.costEstimated;
                return <g key={point.model.key} transform={`translate(${x(point.resource)},${y(point.model.rankScore)})`}
                  role="button" tabIndex={0} aria-pressed={active}
                  aria-label={`${point.model.displayName}, ${Math.round(point.model.rankScore)} rating, ${formatEfficiencyResource(point.resource, metric)}${estimate ? " estimated" : ""}${onFrontier ? ", on frontier" : ""}${provisional ? ", provisional" : ""}`}
                  className={`mb-efficiency-point ${onFrontier ? "text-accent" : "text-muted"}`}
                  data-active={active} style={{ opacity: matches ? 1 : 0.16 }}
                  onMouseEnter={() => { setSelectedKey(point.model.key); setHoveredKey(point.model.key); }}
                  onFocus={() => { setSelectedKey(point.model.key); setHoveredKey(point.model.key); }} onBlur={() => setHoveredKey(null)}
                  onClick={() => setSelectedKey(point.model.key)} onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(point.model.key); }
                  }}>
                  <title>{point.model.displayName}</title>
                  <circle r={14} fill="transparent" />
                  <circle className="mb-efficiency-dot" r={onFrontier ? 5.5 : 4.5} fill={provisional ? "hsl(var(--bg))" : "currentColor"} stroke="currentColor" strokeWidth={1.5} />
                  {active ? <circle r={10} fill="none" stroke="currentColor" strokeWidth={1} /> : null}
                </g>;
              })}
            </svg>
            {selected && hoveredKey === selected.model.key ? <div role="tooltip" className="mb-efficiency-tooltip pointer-events-none absolute max-w-[220px] rounded-md bg-bg px-3 py-2 text-xs ring-1 ring-border"
              style={{ left: Math.max(4, Math.min(width - 224, x(selected.resource) - 110)), top: Math.max(4, y(selected.model.rankScore) - 70) }}>
              <div className="font-medium text-fg">{selected.model.displayName}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-muted tabular-nums"><span>{Math.round(selected.model.rankScore)} rating</span><span>{formatEfficiencyResource(selected.resource, metric)}{metric === "cost" && selected.model.benchmark?.costEstimated ? " est." : ""}</span></div>
            </div> : null}
            {points.length === 0 ? <div className="absolute inset-0 flex items-center justify-center bg-bg px-6 text-center text-sm text-muted">
              {establishedOnly && measured.length ? "No established models have this measurement yet." : "This comparison needs recorded measurements and prompt votes."}
            </div> : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
            <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-0.5 w-5 bg-accent" />Pareto frontier</span>
            <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 rounded-full border border-current" />Provisional</span>
            <span>{points.length} models · {frontier.length} on frontier</span>
          </div>
        </div>
        <aside aria-label="Selected model" className="min-w-0 border-t border-border/60 pt-4 lg:border-t-0 lg:pt-6">
          {selected ? <div key={selected.model.key} className="mb-efficiency-detail">
            <div className="text-xs text-muted">{frontierKeys.has(selected.model.key) ? "Frontier · " : ""}{selected.model.stability}</div>
            <h3 className="mt-2 break-words text-lg font-semibold leading-snug text-fg">
              <Link href={`/leaderboard/${encodeURIComponent(selected.model.slug ?? selected.model.key)}`} className="decoration-accent/40 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{selected.model.displayName}</Link>
            </h3>
            <div className="mt-2 flex items-baseline gap-2 tabular-nums"><span className="text-xl font-semibold text-fg">{Math.round(selected.model.rankScore)}</span><span className="text-xs text-muted">{selected.model.ci95 != null ? `± ${numeric.format(selected.model.ci95)} · 95% CI` : "rating"}</span></div>
            <dl className="mt-5 grid gap-3 text-sm">
              {METRICS.map((item) => {
                const value = getEfficiencyResource(selected.model, item.key);
                return <div key={item.key} className="flex items-baseline justify-between gap-3"><dt className={metric === item.key ? "text-fg" : "text-muted"}>{item.resource}</dt>
                  <dd className={`text-right tabular-nums ${metric === item.key ? "font-semibold text-accent" : "text-fg"}`}>{value == null ? "—" : formatEfficiencyResource(value, item.key)}{value != null && item.key === "cost" && selected.model.benchmark?.costEstimated ? <span className="ml-1 text-xs font-normal text-muted">est.</span> : null}</dd>
                </div>;
              })}
            </dl>
            <p className="mt-5 text-xs leading-relaxed text-muted">{selected.model.sampledVotes.toLocaleString()} votes · {selected.model.sampledPrompts}/{selected.model.activePrompts} prompts{selected.model.meanScore != null ? ` · ${numeric.format(selected.model.meanScore * 100)} prompt score` : ""}</p>
            {selected.model.benchmark?.note ? <p className="mt-2 text-xs leading-relaxed text-muted">{selected.model.benchmark.note.replace(/^\*\s*/, "")}</p> : null}
          </div> : <p className="text-sm text-muted">No measurements available.</p>}
        </aside>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Comparison units" className="mb-leaderboard-switch">
          <button type="button" aria-pressed={!perScore} className="mb-leaderboard-option" onClick={() => setPerScore(false)}>Per build</button>
          <button type="button" aria-pressed={perScore} className="mb-leaderboard-option" onClick={() => setPerScore(true)}>Per score</button>
        </div>
        <span className="text-xs text-muted">{perScore ? "Resource use per prompt-score point" : "Average resource use per build"}</span>
      </div>
      <div className="overflow-x-auto md:overflow-visible">
        <table className="w-full min-w-[680px] table-fixed border-collapse text-sm tabular-nums">
          <caption className="sr-only">Cost, time, and blocks {perScore ? "per observed prompt-score point" : "per build"}</caption>
          <colgroup><col className="w-[34%]" /><col className="w-[12%]" /><col className="w-[18%]" /><col className="w-[18%]" /><col className="w-[18%]" /></colgroup>
          <thead className="border-b border-border bg-bg text-left text-xs text-muted md:sticky md:top-0 md:z-20">
            <tr><th scope="col" className="sticky left-0 z-10 bg-bg py-3 pr-4 font-medium">Model</th>
              {[{ key: "rating", label: "Rating" }, ...METRICS.map((item) => ({ key: item.key, label: item.key === "speed" ? "Time" : item.label }))].map((item) => {
                const key = item.key as typeof sort.key;
                return <th key={key} scope="col" aria-sort={sort.key === key ? sort.descending ? "descending" : "ascending" : "none"} className="text-right font-medium">
                  <button type="button" onClick={() => sortBy(key)} className={`mb-efficiency-sort min-h-11 w-full whitespace-nowrap px-3 text-right ${sort.key === key ? "text-fg" : "text-muted"}`}>
                    {item.label}{perScore && key !== "rating" ? " / score" : ""}<span aria-hidden="true" className={`ml-2 inline-block w-3 ${sort.key === key ? "text-accent" : "opacity-40"}`}>{sort.key === key ? sort.descending ? "↓" : "↑" : "↕"}</span>
                  </button>
                </th>;
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((model) => <tr key={model.key} className={`mb-efficiency-row border-b border-border/40 ${selected?.model.key === model.key ? "bg-fg/[0.03]" : ""}`}>
              <th scope="row" className="sticky left-0 z-10 bg-bg pr-4 text-left font-normal"><button type="button" onClick={() => setSelectedKey(model.key)} onFocus={() => setSelectedKey(model.key)} aria-pressed={selected?.model.key === model.key} className="flex min-h-11 w-full items-start gap-3 py-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <span className="w-6 shrink-0 text-right text-xs leading-5 text-muted2">{model.rank}</span>
                <span className="min-w-0"><span className="block truncate font-medium text-fg">{model.displayName}</span><span className="mt-0.5 block text-xs text-muted">{frontierKeys.has(model.key) ? "Frontier · " : ""}{model.stability}</span></span>
              </button></th>
              <td className="px-3 py-3.5 text-right text-fg">{Math.round(model.rankScore)}</td>
              {METRICS.map((item) => {
                const value = valueFor(model, item.key);
                return <td key={item.key} className={`px-3 py-3.5 text-right ${sort.key === item.key ? "bg-fg/[0.025] font-medium text-fg" : "text-muted"}`}>
                  {value == null ? "—" : formatEfficiencyResource(value, item.key)}{value != null && item.key === "cost" && model.benchmark?.costEstimated ? <span className="ml-1 text-xs font-normal text-muted">est.</span> : null}
                </td>;
              })}
            </tr>)}
            {rows.length === 0 ? <tr><td colSpan={5} className="py-8 text-center text-muted">{modelQuery.trim() ? "No matching models in this comparison." : "No measurements available for this selection."}</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted">
        {models.length > measured.length ? <span>{models.length - measured.length} models lack this measurement or sampled prompt votes.</span> : null}
        {establishedOnly && measured.length > points.length ? <span>{measured.length - points.length} provisional models hidden.</span> : null}
        {modelQuery.trim() ? <span>Search highlights matches; the frontier still includes the full comparison.</span> : null}
      </div>
      <details className="mt-3 text-sm text-muted">
        <summary className="min-h-11 cursor-pointer py-3 font-medium text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Methodology</summary>
        <div className="max-w-[85ch] space-y-3 pb-3 leading-relaxed">
          <p>A model is on the Pareto frontier when no included model has an equal or higher rating with equal or lower resource use, with at least one strict improvement. The frontier follows point estimates; overlapping confidence intervals can mean the differences are uncertain.</p>
          <p>Per-score values divide average resource use by the observed prompt score on a 0–100 scale: wins count as 1, ties as 0.5, and losses as 0, averaged equally over prompts with at least two votes. Both-bad votes are excluded. These ratios depend on sampled opponents and prompts; they describe the evidence rather than replace the rating.</p>
          <p>Cost is recorded cohort expenditure divided by finalized builds, including retries where recorded. Timing uses complete tracked cohorts or documented historical measurements. Block averages require complete public build coverage. Estimates are marked; missing measurements are omitted. New data follows the leaderboard’s regular refresh.</p>
        </div>
      </details>
    </section>
  );
}
