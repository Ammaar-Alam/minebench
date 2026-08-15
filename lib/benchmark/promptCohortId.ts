import { createHash } from "node:crypto";

import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";

// Deterministic identity for a prompt cohort: two cohorts with the same count
// but different prompts hash differently. Versioned so a future serialization
// change cannot silently collide with historical values.
export function promptCohortId(
  promptMap: Readonly<Record<string, string>> = BENCHMARK_PROMPT_MAP,
): string {
  const pairs = Object.entries(promptMap)
    .map(([slug, text]) => [slug, text] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
  return `prompts-v1:${digest.slice(0, 16)}`;
}
