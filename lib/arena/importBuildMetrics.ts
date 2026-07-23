export function parseGenerationTimeMs(
  raw: string | null,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, value: null };
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, error: "generationTimeMs must be a non-negative integer" };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 2_147_483_647) {
    return { ok: false, error: "generationTimeMs is outside the supported integer range" };
  }
  return { ok: true, value };
}

export function resolveImportedGenerationTimeMs(value: number | null): number {
  return value ?? 0;
}
