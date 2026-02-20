const TOKEN_BUDGET_FALLBACKS = [
  262_144, 196_608, 131_072, 128_000, 100_000, 98_304, 65_536, 64_000, 49_152, 32_768, 24_576, 16_384, 12_288, 8_192,
  6_144, 4_096, 2_048,
];

export const DEFAULT_MAX_OUTPUT_TOKENS = 262_144;

export function tokenBudgetCandidates(requested: number): number[] {
  const requestedTokens =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_OUTPUT_TOKENS;

  const uniq: number[] = [];
  for (const tokenBudget of [requestedTokens, ...TOKEN_BUDGET_FALLBACKS]) {
    const normalized = Math.floor(tokenBudget);
    if (normalized <= 0 || !Number.isFinite(normalized) || uniq.includes(normalized)) continue;
    uniq.push(normalized);
  }

  uniq.sort((a, b) => b - a);
  return uniq;
}
