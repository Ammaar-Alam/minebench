import { findCatalogEntryBySlugOrKey } from "../lib/ai/modelCatalog";
import { arenaCohortBuildWhere } from "../lib/arena/eligibility";

// Shared CLI surface for the arena maintenance scripts: cohort scoping by
// model, explicit build IDs for nonstandard rows, and missing-only discovery

export type ArenaMaintenanceArgs = {
  dryRun: boolean;
  limit: number;
  all: boolean;
  buildIds: string[];
  modelKeys: string[];
  missingOnly: boolean;
};

export function parseArenaMaintenanceArgs(args: string[]): ArenaMaintenanceArgs {
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const missingOnly = args.includes("--missing-only");

  const limitIndex = args.indexOf("--limit");
  const parsedLimit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 250;

  const buildIds: string[] = [];
  const modelKeys: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--build") {
      const next = args[i + 1]?.trim();
      if (next) buildIds.push(next);
    }
    if (args[i] === "--model") {
      const next = args[i + 1]?.trim();
      if (!next) continue;
      const entry = findCatalogEntryBySlugOrKey(next);
      if (!entry) {
        throw new Error(`Unknown model key or slug: ${next}`);
      }
      modelKeys.push(entry.key);
    }
  }

  if (buildIds.length > 0 && modelKeys.length > 0) {
    throw new Error("--build and --model are mutually exclusive");
  }

  return { dryRun, limit, all, buildIds, modelKeys, missingOnly };
}

// Explicit --build preserves its exact semantics for nonstandard rows;
// otherwise the shared cohort filter applies, optionally scoped by model
export function arenaMaintenanceWhere(opts: {
  buildIds: string[];
  modelKeys: string[];
}) {
  return opts.buildIds.length > 0
    ? { id: { in: opts.buildIds } }
    : arenaCohortBuildWhere(opts.modelKeys);
}

export function describeScope(opts: ArenaMaintenanceArgs): string[] {
  const lines: string[] = [];
  if (opts.buildIds.length > 0) lines.push(`- build filter: ${opts.buildIds.join(", ")}`);
  if (opts.modelKeys.length > 0) lines.push(`- model filter: ${opts.modelKeys.join(", ")}`);
  if (opts.missingOnly) lines.push("- missing-only: yes");
  return lines;
}
