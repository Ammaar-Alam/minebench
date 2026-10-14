"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LeaderboardResponse } from "@/lib/arena/types";
import {
  formatEfficiencyResource,
  getEfficiencyAxisDomain,
  getEfficiencyPoints,
  getEfficiencyResource,
  getEfficiencyTicks,
  getParetoFrontier,
  getResourcePerScore,
  placeEfficiencyLabels,
  type EfficiencyMetric,
} from "@/lib/leaderboardEfficiency";
import { matchesLeaderboardModelQuery } from "@/lib/leaderboardSearch";

const METRICS = [
  { key: "cost", label: "Cost", resource: "Cost per build" },
  { key: "speed", label: "Speed", resource: "Time per build" },
  { key: "blocks", label: "Blocks", resource: "Blocks per build" },
] as const;
const PAD = { left: 48, right: 16, top: 32, bottom: 56 };
const LABEL_HEIGHT = 15;
const WATERMARK = "minebench.ai";
const numeric = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

let measureContext: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, font: string) {
  if (measureContext === undefined) measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 7;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

export function LeaderboardEfficiency({ models, modelQuery }: {
  models: LeaderboardResponse["models"];
  modelQuery: string;
}) {
  const headingId = useId();
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [viewportHeight, setViewportHeight] = useState(1000);
  const [font, setFont] = useState({ family: "sans-serif" });
  const [metric, setMetric] = useState<EfficiencyMetric>("cost");
  const [establishedOnly, setEstablishedOnly] = useState(false);
  const [logScale, setLogScale] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [perScore, setPerScore] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
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
  // fits the chart, its controls, and the legend inside the leaderboard scroll area below the header
  const height = Math.round(Math.max(320, Math.min(580, width * 0.54, viewportHeight - 500)));
  const compact = width < 560;
  const plot = { x: PAD.left, y: PAD.top, width: width - PAD.left - PAD.right, height: height - PAD.top - PAD.bottom };
  const x = (value: number) => plot.x + ((useLog ? Math.log10(value) : value) - xMin) / (xMax - xMin) * plot.width;
  const y = (value: number) => plot.y + (yMax - value) / (yMax - yMin) * plot.height;
  const xTicks = getEfficiencyTicks([xMin, xMax], metric, Math.max(3, Math.floor(plot.width / 72)), useLog);
  const yTicks = getEfficiencyTicks([yMin, yMax], "rating", compact ? 5 : 7);
  const labelFont = `600 ${compact ? 11 : 12}px ${font.family}`;
  const watermark = { x: plot.x + plot.width - 8, y: plot.y + plot.height - 12, width: measureText(WATERMARK, labelFont) };
  // frontier first, then rating, so the models that matter keep their labels
  const labelOrder = [...points].sort((a, b) =>
    Number(frontierKeys.has(b.model.key)) - Number(frontierKeys.has(a.model.key)) || b.model.rankScore - a.model.rankScore);
  const labels = placeEfficiencyLabels(
    labelOrder.map((point) => ({ key: point.model.key, x: x(point.resource), y: y(point.model.rankScore), width: measureText(point.model.displayName, labelFont), far: true })),
    [
      ...points.map((point) => ({ key: point.model.key, x: x(point.resource) - 6, y: y(point.model.rankScore) - 6, width: 12, height: 12 })),
      { x: watermark.x - watermark.width, y: watermark.y - LABEL_HEIGHT / 2, width: watermark.width, height: LABEL_HEIGHT },
    ],
    { x: 0, y: plot.y - 12, width, height: plot.height + 12 },
    LABEL_HEIGHT,
  );
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
  // entrance: frontier dots pop as the line reaches them, the rest sweep in left to right
  const frontierPath = frontier.map((point) => [x(point.resource), y(point.model.rankScore)] as const);
  const frontierLengths = frontierPath.map((point, index) => index ? Math.hypot(point[0] - frontierPath[index - 1][0], point[1] - frontierPath[index - 1][1]) : 0);
  const frontierTotal = frontierLengths.reduce((sum, length) => sum + length, 0) || 1;
  const appear = new Map<string, number>();
  let travelled = 0;
  frontier.forEach((point, index) => {
    travelled += frontierLengths[index];
    appear.set(point.model.key, Math.round(60 + 600 * travelled / frontierTotal));
  });
  for (const point of points) {
    if (!appear.has(point.model.key)) appear.set(point.model.key, Math.round(340 + 520 * (x(point.resource) - plot.x) / plot.width));
  }
  const hover = (key: string | null) => {
    setHoveredKey(key);
    if (key) setSelectedKey(key);
  };
  // hovering any model fades the rest so its dot and name read as a pair
  const emphasis = (key: string) => hoveredKey && hoveredKey !== key ? 0.22 : 1;
  const sortBy = (key: typeof sort.key) => {
    setSort((current) => ({ key, descending: current.key === key ? !current.descending : key === "rating" }));
    if (key !== "rating") setMetric(key);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setEntered(true), 1400);
    return () => window.clearTimeout(timer);
  }, []);

  useLayoutEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    setWidth(Math.max(260, element.clientWidth));
    // a fresh object re-measures labels once web fonts land
    const readFont = () => setFont({ family: getComputedStyle(element).fontFamily });
    readFont();
    void document.fonts?.ready.then(readFont);
    const readViewport = () => setViewportHeight(window.innerHeight);
    readViewport();
    window.addEventListener("resize", readViewport);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)));
    observer.observe(element);
    return () => { observer.disconnect(); window.removeEventListener("resize", readViewport); };
  }, []);

  return (
    <section aria-labelledby={headingId} className="mb-efficiency-enter min-w-0 pb-5">
      <h2 id={headingId} className="sr-only">Model efficiency</h2>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div role="group" aria-label="Efficiency metric" className="mb-choice-group">
          {METRICS.map((item) => (
            <button key={item.key} type="button" aria-pressed={metric === item.key}
              onClick={() => { setMetric(item.key); setSort({ key: item.key, descending: false }); }}
              className="mb-choice-option">
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
      <div className="grid gap-x-10 pb-8 pt-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0">
        <div ref={chartRef} className="relative min-w-0" style={{ height }} onMouseLeave={() => setHoveredKey(null)}>
          <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${config.resource} versus rating`} className="block overflow-visible">
            <title>{`${config.resource} versus rating; higher and further left is better`}</title>
            <g aria-hidden="true" className="text-border">
              {yTicks.map((rating) => <g key={`y${rating}`}>
                <line x1={plot.x} x2={plot.x + plot.width} y1={y(rating)} y2={y(rating)} stroke="currentColor" strokeOpacity={0.7} />
                <text x={plot.x - 10} y={y(rating)} dominantBaseline="central" textAnchor="end" className="fill-muted2 text-[11px] tabular-nums">{rating}</text>
              </g>)}
              {xTicks.map((resource) => <g key={`x${resource}`}>
                <line x1={x(resource)} x2={x(resource)} y1={plot.y} y2={plot.y + plot.height} stroke="currentColor" strokeOpacity={0.35} />
                <text x={x(resource)} y={plot.y + plot.height + 20} textAnchor="middle" className="fill-muted2 text-[11px] tabular-nums">{formatEfficiencyResource(resource, metric)}</text>
              </g>)}
              <text x={plot.x - 10} y={plot.y - 16} textAnchor="end" className="fill-muted text-[12px] font-medium">Rating</text>
              <text x={plot.x + plot.width / 2} y={height - 8} textAnchor="middle" className="fill-muted text-[12px] font-medium">
                {metric === "blocks" ? config.resource : `${config.resource} · lower is better`}{useLog ? " · log" : ""}
              </text>
              <text x={watermark.x} y={watermark.y} dominantBaseline="central" textAnchor="end" className="fill-fg/25 text-[12px] font-semibold tracking-tight">{WATERMARK}</text>
            </g>
            {frontier.length > 1 ? <path key={`${metric}-${useLog}-${establishedOnly}`} className="mb-efficiency-frontier" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" pathLength={1}
              style={{ opacity: hoveredKey && !frontierKeys.has(hoveredKey) ? 0.35 : 1 }}
              d={frontierPath.map(([px, py], index) => `${index ? "L" : "M"}${px},${py}`).join(" ")} /> : null}
            {selected ? <g aria-hidden="true" className="text-muted/30" stroke="currentColor" strokeDasharray="3 5">
              <line className="mb-efficiency-guide" x1={0} x2={0} y1={plot.y} y2={plot.y + plot.height} style={{ transform: `translateX(${x(selected.resource)}px)` }} />
              <line className="mb-efficiency-guide" x1={plot.x} x2={plot.x + plot.width} y1={0} y2={0} style={{ transform: `translateY(${y(selected.model.rankScore)}px)` }} />
            </g> : null}
            {points.map((point) => {
              const active = selected?.model.key === point.model.key;
              const onFrontier = frontierKeys.has(point.model.key);
              const matches = matchesLeaderboardModelQuery(point.model, modelQuery);
              const provisional = point.model.stability === "Provisional";
              const estimate = metric === "cost" && point.model.benchmark?.costEstimated;
              return <g key={point.model.key} style={{ transform: `translate(${x(point.resource)}px, ${y(point.model.rankScore)}px)`, opacity: matches ? emphasis(point.model.key) : 0.16 }}
                role="button" tabIndex={0} aria-pressed={active}
                aria-label={`${point.model.displayName}, ${Math.round(point.model.rankScore)} rating, ${formatEfficiencyResource(point.resource, metric)}${estimate ? " estimated" : ""}${onFrontier ? ", on frontier" : ""}${provisional ? ", provisional" : ""}`}
                className={`mb-efficiency-point ${onFrontier ? "text-accent" : "text-muted"}`}
                data-active={active}
                onMouseEnter={() => hover(point.model.key)} onMouseLeave={() => hover(null)}
                onFocus={() => hover(point.model.key)} onBlur={() => hover(null)}
                onClick={() => setSelectedKey(point.model.key)} onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(point.model.key); }
                }}>
                <title>{point.model.displayName}</title>
                <circle r={14} fill="transparent" />
                <circle className="mb-efficiency-dot" style={{ animationDelay: `${appear.get(point.model.key)}ms` }} r={onFrontier ? 5.5 : 4.5}
                  fill={provisional ? "hsl(var(--bg))" : "currentColor"} stroke={provisional ? "currentColor" : "hsl(var(--bg))"} strokeWidth={1.5} />
                {active ? <circle r={10} fill="none" stroke="currentColor" strokeWidth={1} /> : null}
              </g>;
            })}
            <g aria-hidden="true">
              {points.map((point) => {
                const end = labels.get(point.model.key)?.leader;
                if (!end) return null;
                const px = x(point.resource);
                const py = y(point.model.rankScore);
                const [ex, ey] = [end.x, end.y];
                const length = Math.hypot(ex - px, ey - py) || 1;
                return <line key={`${point.model.key}-${metric}-${useLog}-${establishedOnly}`} className="mb-efficiency-leader pointer-events-none text-muted2" stroke="currentColor" strokeWidth={1}
                  style={{ opacity: emphasis(point.model.key), animationDelay: `${entered ? 280 : (appear.get(point.model.key) ?? 0) + 160}ms` }}
                  x1={px + (ex - px) / length * 7} y1={py + (ey - py) / length * 7} x2={ex} y2={ey} />;
              })}
              {points.map((point) => {
                const placed = labels.get(point.model.key);
                const active = selected?.model.key === point.model.key;
                const onFrontier = frontierKeys.has(point.model.key);
                const opacity = !placed ? 0 : matchesLeaderboardModelQuery(point.model, modelQuery) ? emphasis(point.model.key) : 0.16;
                return <text key={point.model.key} dominantBaseline="central"
                  className={`mb-efficiency-label cursor-pointer ${compact ? "text-[11px]" : "text-[12px]"} font-semibold ${active || onFrontier ? "fill-fg" : "fill-muted"}`}
                  stroke="hsl(var(--bg))" strokeWidth={3.5} strokeLinejoin="round" paintOrder="stroke"
                  onMouseEnter={() => hover(point.model.key)} onMouseLeave={() => hover(null)} onClick={() => setSelectedKey(point.model.key)}
                  style={{ transform: `translate(${placed?.x ?? x(point.resource) + 8}px, ${placed?.y ?? y(point.model.rankScore)}px)`, opacity, pointerEvents: placed ? "auto" : "none", animationDelay: `${(appear.get(point.model.key) ?? 0) + 140}ms` }}>
                  {point.model.displayName}
                </text>;
              })}
            </g>
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
          <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-0.5 w-5 rounded-full bg-accent" />Pareto frontier</span>
          <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 rounded-full border border-current" />Provisional</span>
          <span>{points.length} models · {frontier.length} on frontier</span>
        </div>
        </div>
        <aside aria-label="Selected model" className="mt-6 min-w-0 border-t border-border/60 pt-5 lg:mt-0 lg:border-t-0 lg:pt-6">
          {selected ? <div key={selected.model.key} className="mb-efficiency-detail grid gap-x-8 gap-y-5 sm:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] lg:grid-cols-1 lg:gap-y-3">
            <div className="min-w-0">
              <div className="text-xs text-muted">{frontierKeys.has(selected.model.key) ? "Frontier · " : ""}{selected.model.stability}</div>
              <h3 className="mt-1.5 truncate text-lg font-semibold leading-snug text-fg lg:whitespace-normal lg:break-words">
                <Link href={`/leaderboard/${encodeURIComponent(selected.model.slug ?? selected.model.key)}`} className="decoration-accent/40 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{selected.model.displayName}</Link>
              </h3>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums lg:mb-2"><span className="text-xl font-semibold text-fg">{Math.round(selected.model.rankScore)}</span><span className="text-xs text-muted">{selected.model.ci95 != null ? `± ${numeric.format(selected.model.ci95)} · 95% CI` : "rating"}</span></div>
            </div>
            <dl className="contents">
              {METRICS.map((item) => {
                const value = getEfficiencyResource(selected.model, item.key);
                return <div key={item.key} className="min-w-0 sm:pt-5 lg:flex lg:items-baseline lg:justify-between lg:gap-3 lg:pt-0">
                  <dt className={`text-xs lg:text-sm ${metric === item.key ? "text-fg" : "text-muted"}`}>{item.resource}</dt>
                  <dd className={`mt-1 text-lg tabular-nums lg:mt-0 lg:text-right lg:text-sm ${metric === item.key ? "font-semibold text-accent" : "text-fg"}`}>{value == null ? "—" : formatEfficiencyResource(value, item.key)}{value != null && item.key === "cost" && selected.model.benchmark?.costEstimated ? <span className="ml-1 text-xs font-normal text-muted">est.</span> : null}</dd>
                </div>;
              })}
            </dl>
            <p className="text-xs leading-relaxed text-muted sm:col-span-4 lg:col-span-1 lg:mt-2">{selected.model.sampledVotes.toLocaleString()} votes · {selected.model.sampledPrompts}/{selected.model.activePrompts} prompts{selected.model.meanScore != null ? ` · ${numeric.format(selected.model.meanScore * 100)} prompt score` : ""}{selected.model.benchmark?.note ? ` · ${selected.model.benchmark.note.replace(/^\*\s*/, "")}` : ""}</p>
          </div> : <p className="text-sm text-muted">No measurements available.</p>}
        </aside>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Comparison units" className="mb-choice-group">
          <button type="button" aria-pressed={!perScore} className="mb-choice-option" onClick={() => setPerScore(false)}>Per build</button>
          <button type="button" aria-pressed={perScore} className="mb-choice-option" onClick={() => setPerScore(true)}>Per score</button>
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
        <summary className="mb-disclosure-toggle py-3 font-medium text-fg">
          <span>Methodology</span>
          <svg aria-hidden="true" className="mb-disclosure-chevron h-3 w-3 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6.5L8 10.5L12 6.5" />
          </svg>
        </summary>
        <div className="space-y-3 pb-3 leading-relaxed">
          <p>A model is on the Pareto frontier when no included model has an equal or higher rating with equal or lower resource use, with at least one strict improvement. The frontier follows point estimates; overlapping confidence intervals can mean the differences are uncertain.</p>
          <p>Per-score values divide average resource use by the observed prompt score on a 0–100 scale: wins count as 1, ties as 0.5, and losses as 0, averaged equally over prompts with at least two votes. Both-bad votes are excluded. These ratios depend on sampled opponents and prompts; they describe the evidence rather than replace the rating.</p>
          <p>Cost is recorded cohort expenditure divided by finalized builds, including retries where recorded. Timing uses complete tracked cohorts or documented historical measurements. Block averages require complete public build coverage. Estimates are marked; missing measurements are omitted. New data follows the leaderboard’s regular refresh.</p>
        </div>
      </details>
    </section>
  );
}
