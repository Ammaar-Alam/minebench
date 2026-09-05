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
  type EfficiencyMetric,
} from "@/lib/leaderboardEfficiency";
import { matchesLeaderboardModelQuery } from "@/lib/leaderboardSearch";

const METRICS = [
  { key: "cost", label: "Cost", resource: "Cost per build", ratio: "Cost per score point" },
  { key: "speed", label: "Speed", resource: "Time per build", ratio: "Time per score point" },
  { key: "blocks", label: "Blocks", resource: "Blocks per build", ratio: "Blocks per score point" },
] as const;
const HEIGHT = 340;
const PAD = { left: 52, right: 28, top: 34, bottom: 54 };
const control = "mb-btn mb-btn-ghost h-11 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
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
  const [sort, setSort] = useState<"rating" | "resource" | "ratio">("rating");
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
  const rows = points.filter((point) => matchesLeaderboardModelQuery(point.model, modelQuery)).sort((a, b) =>
    (sort === "ratio" ? (a.perScore ?? Infinity) - (b.perScore ?? Infinity)
      : sort === "resource" ? a.resource - b.resource : b.model.rankScore - a.model.rankScore) || a.model.key.localeCompare(b.model.key),
  );

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section aria-labelledby={headingId} className="mb-efficiency-enter px-1 pb-5 sm:px-2">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5 pt-1">
        <div>
          <h2 id={headingId} className="font-display text-2xl font-semibold tracking-tight text-fg">Quality meets efficiency</h2>
          <p className="mt-1 text-sm text-muted">Explore the trade-offs.</p>
        </div>
        <div role="group" aria-label="Efficiency metric" className="flex gap-1 rounded-md border border-border p-1">
          {METRICS.map((item) => (
            <button key={item.key} type="button" aria-pressed={metric === item.key} onClick={() => setMetric(item.key)}
              className={`${control} ${metric === item.key ? "bg-accent/10 text-accent" : "text-muted"}`}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-y border-border py-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-0.5 w-5 bg-accent" />Pareto frontier</span>
          <span>{points.length} models · {frontier.length} on frontier</span>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-muted">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2">
            <input type="checkbox" checked={establishedOnly} onChange={(event) => setEstablishedOnly(event.target.checked)} className="h-4 w-4 accent-accent" />
            Established only
          </label>
          <label className={`inline-flex min-h-11 items-center gap-2 ${canUseLog ? "cursor-pointer" : "opacity-50"}`}>
            <input type="checkbox" checked={useLog} disabled={!canUseLog} onChange={(event) => setLogScale(event.target.checked)} className="h-4 w-4 accent-accent" />
            Log scale
          </label>
        </div>
      </div>
      <div className="grid gap-5 py-5 xl:grid-cols-[minmax(0,1fr)_17rem] xl:gap-8">
        <div className="min-w-0">
          <div ref={chartRef} className="relative min-w-0">
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
                  onMouseEnter={() => setSelectedKey(point.model.key)} onFocus={() => setSelectedKey(point.model.key)}
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
            {points.length === 0 ? <div className="absolute inset-0 flex items-center justify-center bg-bg px-6 text-center text-sm text-muted">
              {establishedOnly && measured.length ? "No established models have this measurement yet." : "This comparison needs recorded measurements and prompt votes."}
            </div> : null}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Frontier models offer the best rating at their resource level. Hollow points are provisional.
            {metric === "blocks" ? " Fewer blocks describe a smaller build, not better quality." : ""}
          </p>
        </div>
        <aside aria-label="Selected model" className="min-w-0 border-t border-border pt-4 xl:border-t-0 xl:pt-1">
          {selected ? <div key={selected.model.key} className="mb-efficiency-detail">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className={frontierKeys.has(selected.model.key) ? "text-accent" : ""}>{frontierKeys.has(selected.model.key) ? "On the frontier" : "Outside the frontier"}</span>
              <span>· {selected.model.stability}</span>
            </div>
            <h3 className="mt-2 break-words font-display text-xl font-semibold leading-tight text-fg">
              <Link href={`/leaderboard/${encodeURIComponent(selected.model.slug ?? selected.model.key)}`} className="decoration-accent/40 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{selected.model.displayName}</Link>
            </h3>
            <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
              {[
                ["Rating", `${Math.round(selected.model.rankScore)}${selected.model.ci95 != null ? ` ± ${numeric.format(selected.model.ci95)}` : ""}`],
                ...METRICS.map((item) => {
                  const value = getEfficiencyResource(selected.model, item.key);
                  return [item.resource, value == null ? "Not recorded" : `${formatEfficiencyResource(value, item.key)}${item.key === "cost" && selected.model.benchmark?.costEstimated ? " est." : ""}`];
                }),
                ["Prompt score", selected.model.meanScore == null ? "Not scored" : `${numeric.format(selected.model.meanScore * 100)} / 100`],
                [config.ratio, selected.perScore == null ? "Not scored" : `${formatEfficiencyResource(selected.perScore, metric)}${metric === "cost" && selected.model.benchmark?.costEstimated ? " est." : ""}`],
              ].map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-2.5"><dt className="text-muted">{label}</dt><dd className="text-right font-medium tabular-nums text-fg">{value}</dd></div>)}
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-muted">{selected.model.sampledVotes.toLocaleString()} votes across {selected.model.sampledPrompts}/{selected.model.activePrompts} prompts. Rating intervals are 95% confidence intervals.</p>
            {selected.model.benchmark?.note ? <p className="mt-2 text-xs leading-relaxed text-muted">{selected.model.benchmark.note.replace(/^\*\s*/, "")}</p> : null}
          </div> : <p className="text-sm text-muted">More comparisons will appear as models are measured and rated.</p>}
        </aside>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pb-2 pt-4">
        <h3 className="font-display text-lg font-semibold text-fg">Compare the numbers</h3>
        <label className="flex min-h-11 items-center gap-2 text-sm text-muted">Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="mb-field h-11 px-3 text-sm text-fg">
            <option value="rating">Rating</option><option value="resource">{config.resource}</option><option value="ratio">Per score point</option>
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] border-collapse text-sm tabular-nums">
          <caption className="sr-only">{config.resource} and resource use per observed prompt-score point</caption>
          <thead className="border-y border-border text-left text-xs text-muted">
            <tr><th className="py-3 pr-4 font-medium">Model</th><th className="px-3 py-3 text-right font-medium">Rating</th><th className="px-3 py-3 text-right font-medium">{config.resource}</th><th className="px-3 py-3 text-right font-medium">Per score point</th><th className="py-3 pl-3 text-right font-medium">Prompt coverage</th></tr>
          </thead>
          <tbody>
            {rows.map((point) => <tr key={point.model.key} className={`mb-efficiency-row border-b border-border/60 ${selected?.model.key === point.model.key ? "bg-fg/[0.03]" : ""}`}>
              <th scope="row" className="pr-4 text-left font-normal"><button type="button" onClick={() => setSelectedKey(point.model.key)} onFocus={() => setSelectedKey(point.model.key)} aria-pressed={selected?.model.key === point.model.key} className="min-h-11 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <span className="font-medium text-fg">{point.model.displayName}</span>
                <span className="mt-0.5 block text-xs text-muted">{frontierKeys.has(point.model.key) ? "Frontier · " : ""}{point.model.stability}</span>
              </button></th>
              <td className="px-3 py-3 text-right text-fg">{Math.round(point.model.rankScore)}</td>
              <td className="px-3 py-3 text-right text-fg">{formatEfficiencyResource(point.resource, metric)}{metric === "cost" && point.model.benchmark?.costEstimated ? <span className="ml-1 text-xs text-muted">est.</span> : null}</td>
              <td className="px-3 py-3 text-right text-fg">{point.perScore == null ? "—" : formatEfficiencyResource(point.perScore, metric)}{point.perScore != null && metric === "cost" && point.model.benchmark?.costEstimated ? <span className="ml-1 text-xs text-muted">est.</span> : null}</td>
              <td className="py-3 pl-3 text-right text-muted">{point.model.sampledPrompts}/{point.model.activePrompts}</td>
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
        <summary className="min-h-11 cursor-pointer py-3 font-medium text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">How to read these metrics</summary>
        <div className="max-w-[85ch] space-y-3 pb-3 leading-relaxed">
          <p>A model is on the Pareto frontier when no included model has an equal or higher rating with equal or lower resource use, with at least one strict improvement. The frontier follows point estimates; overlapping confidence intervals can mean the differences are uncertain.</p>
          <p>Per-score values divide average resource use by the observed prompt score on a 0–100 scale: wins count as 1, ties as 0.5, and losses as 0, averaged equally over prompts with at least two votes. Both-bad votes are excluded. These ratios depend on sampled opponents and prompts; they describe the evidence rather than replace the rating.</p>
          <p>Cost is recorded cohort expenditure divided by finalized builds, including retries where recorded. Timing uses complete tracked cohorts or documented historical measurements. Block averages require complete public build coverage. Estimates are marked; missing measurements are omitted. New data follows the leaderboard’s regular refresh.</p>
        </div>
      </details>
    </section>
  );
}
