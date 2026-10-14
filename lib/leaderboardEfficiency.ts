import type { LeaderboardResponse } from "@/lib/arena/types";

type LeaderboardModel = LeaderboardResponse["models"][number];
export type EfficiencyMetric = "cost" | "speed" | "blocks";
export type EfficiencyPoint = {
  model: LeaderboardModel;
  resource: number;
  perScore: number | null;
};

export function getEfficiencyResource(model: LeaderboardModel, metric: EfficiencyMetric): number | null {
  const benchmark = model.benchmark;
  const value = metric === "cost"
    ? benchmark?.averageCostUsd
    : metric === "speed"
      ? benchmark?.averageTimeMs == null ? null : benchmark.averageTimeMs / 1000
      : benchmark?.averageBlocks;
  return value != null && Number.isFinite(value) && value >= 0 && (metric === "cost" || value > 0)
    ? value
    : null;
}

export function getEfficiencyPoints(
  models: LeaderboardModel[],
  metric: EfficiencyMetric,
  establishedOnly = false,
): EfficiencyPoint[] {
  return models.flatMap((model) => {
    const resource = getEfficiencyResource(model, metric);
    if (
      resource == null || !Number.isFinite(model.rankScore) ||
      model.sampledPrompts <= 0 || model.sampledVotes <= 0 ||
      (establishedOnly && model.stability === "Provisional")
    ) return [];
    return [{
      model,
      resource,
      perScore: getResourcePerScore(resource, model.meanScore),
    }];
  }).sort((a, b) => a.resource - b.resource || b.model.rankScore - a.model.rankScore || a.model.key.localeCompare(b.model.key));
}

export function getResourcePerScore(resource: number | null, score: number | null): number | null {
  return resource != null && score != null && Number.isFinite(score) && score > 0 && score <= 1
    ? resource / (score * 100)
    : null;
}

export function getParetoFrontier(points: EfficiencyPoint[]): EfficiencyPoint[] {
  const sorted = [...points].sort((a, b) => a.resource - b.resource || b.model.rankScore - a.model.rankScore);
  let bestScore = -Infinity;
  let bestResource = -Infinity;
  return sorted.filter((point) => {
    const score = point.model.rankScore;
    if (score < bestScore || (score === bestScore && point.resource > bestResource)) return false;
    bestScore = score;
    bestResource = point.resource;
    return true;
  });
}

export function getEfficiencyAxisDomain(values: number[], logarithmic = false): [number, number] {
  if (values.length === 0) return [0, 1];
  const scaled = logarithmic ? values.map(Math.log10) : values;
  const min = Math.min(...scaled);
  const max = Math.max(...scaled);
  const padding = (max - min) * 0.08 || Math.max(Math.abs(min) * 0.08, 0.1);
  return [logarithmic ? min - padding : Math.min(min, Math.max(0, min - padding)), max + padding];
}

// seconds that read as round clock values
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

// round tick values inside a domain from getEfficiencyAxisDomain, in data units
export function getEfficiencyTicks(
  domain: [number, number],
  metric: EfficiencyMetric | "rating",
  maxTicks: number,
  logarithmic = false,
): number[] {
  const [min, max] = logarithmic ? [10 ** domain[0], 10 ** domain[1]] : domain;
  const inside = (values: number[]) => values.filter((value) => value >= min && value <= max);
  if (logarithmic) {
    const decades = Array.from({ length: Math.ceil(domain[1]) - Math.floor(domain[0]) + 1 }, (_, index) => Math.floor(domain[0]) + index);
    const major = inside(metric === "speed" ? [1, 10, 60, 600, 3600, 36000] : decades.map((decade) => 10 ** decade));
    const minor = inside(metric === "speed" ? TIME_STEPS : decades.flatMap((decade) => [1, 2, 5].map((step) => Number((step * 10 ** decade).toPrecision(12)))));
    const ticks = minor.length <= maxTicks || major.length < 2 ? minor : major;
    // narrow bands can miss every round value, so fall through to evenly spaced ticks
    if (ticks.length) return ticks;
  }
  const rough = (max - min) / Math.max(1, maxTicks - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough || 1));
  const steps = metric === "speed" ? TIME_STEPS : [1, 2, 2.5, 5, 10].map((step) => step * magnitude);
  const step = steps.find((candidate) => candidate >= rough) ?? steps.at(-1)!;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

export type ChartBox = { x: number; y: number; width: number; height: number };

// greedy direct labeling: callers pass labels in priority order, a label is skipped when no slot is free
// labels marked far may sit one step out with a leader line when every adjacent slot is taken
export function placeEfficiencyLabels(
  labels: { key: string; x: number; y: number; width: number; far?: boolean }[],
  obstacles: (ChartBox & { key?: string })[],
  bounds: ChartBox,
  height = 14,
  gap = 10,
): Map<string, { x: number; y: number; leader: { x: number; y: number } | null }> {
  const taken: (ChartBox & { key?: string; label?: boolean })[] = [...obstacles];
  // left edge and vertical center of each placed label, plus where a leader line meets it
  const placed = new Map<string, { x: number; y: number; leader: { x: number; y: number } | null }>();
  const overlaps = (a: ChartBox, b: ChartBox) =>
    a.x < b.x + b.width + 2 && b.x < a.x + a.width + 2 && a.y < b.y + b.height + 1 && b.y < a.y + a.height + 1;
  for (const label of labels) {
    const { x, y, width } = label;
    const slots = (label.far ? [gap, gap * 3] : [gap]).flatMap((distance) => {
      const diagonal = distance * 0.6;
      return [
        [x + distance, y - height / 2],
        [x - distance - width, y - height / 2],
        [x + diagonal, y - diagonal - height],
        [x + diagonal, y + diagonal],
        [x - diagonal - width, y - diagonal - height],
        [x - diagonal - width, y + diagonal],
        [x - width / 2, y - distance - height],
        [x - width / 2, y + distance],
      ].map(([left, top]) => ({ left, top, leader: distance > gap }));
    });
    for (const { left, top, leader } of slots) {
      const box = { x: left, y: top, width, height };
      if (left < bounds.x || top < bounds.y || left + width > bounds.x + bounds.width || top + height > bounds.y + bounds.height) continue;
      if (taken.some((other) => other.key !== label.key && overlaps(box, other))) continue;
      // an unled label must sit nearer its own dot than any other, or it reads as the wrong model
      const reach = (px: number, py: number) => Math.hypot(Math.max(left - px, 0, px - left - width), Math.max(top - py, 0, py - top - height));
      const own = reach(x, y);
      if (!leader && obstacles.some((other) => other.key && other.key !== label.key && reach(other.x + other.width / 2, other.y + other.height / 2) < own + 3)) continue;
      const end = leader ? { x: Math.max(left - 2, Math.min(left + width + 2, x)), y: Math.max(top, Math.min(top + height, y)) } : null;
      // leaders must not cut through another label
      if (end && taken.some((other) => other.label && [0.2, 0.4, 0.6, 0.8].some((t) => {
        const px = x + (end.x - x) * t;
        const py = y + (end.y - y) * t;
        return px > other.x && px < other.x + other.width && py > other.y && py < other.y + other.height;
      }))) continue;
      taken.push({ ...box, label: true });
      placed.set(label.key, { x: left, y: top + height / 2, leader: end });
      break;
    }
  }
  return placed;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
const blockFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });

export function formatEfficiencyResource(value: number, metric: EfficiencyMetric): string {
  if (metric === "cost") return `$${numberFormat.format(value)}`;
  if (metric === "blocks") return blockFormat.format(value);
  if (value >= 3600) return `${numberFormat.format(value / 3600)}h`;
  if (value >= 60) return `${numberFormat.format(value / 60)}m`;
  return `${numberFormat.format(value)}s`;
}
