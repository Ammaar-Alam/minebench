import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";

// Seeding mirrors the full benchmark cohort so the curated list cannot drift
// from the prompts the benchmark actually runs
export const CURATED_PROMPTS: string[] = Object.values(BENCHMARK_PROMPT_MAP);
