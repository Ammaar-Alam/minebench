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
    const score = model.meanScore;
    return [{
      model,
      resource,
      perScore: score != null && Number.isFinite(score) && score > 0 && score <= 1
        ? resource / (score * 100)
        : null,
    }];
  }).sort((a, b) => a.resource - b.resource || b.model.rankScore - a.model.rankScore || a.model.key.localeCompare(b.model.key));
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

const numberFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
const blockFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });

export function formatEfficiencyResource(value: number, metric: EfficiencyMetric): string {
  if (metric === "cost") return `$${numberFormat.format(value)}`;
  if (metric === "blocks") return blockFormat.format(value);
  if (value >= 3600) return `${numberFormat.format(value / 3600)}h`;
  if (value >= 60) return `${numberFormat.format(value / 60)}m`;
  return `${numberFormat.format(value)}s`;
}
