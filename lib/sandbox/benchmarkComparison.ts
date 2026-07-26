export const SANDBOX_COMPARISON_SLOTS = ["a", "b", "c", "d"] as const;

export type SandboxComparisonSlot = (typeof SANDBOX_COMPARISON_SLOTS)[number];
export type SandboxComparisonSelection<T> = Record<SandboxComparisonSlot, T>;

export const SANDBOX_COMPARISON_MODEL_PARAMS: SandboxComparisonSelection<string> = {
  a: "modelA",
  b: "modelB",
  c: "modelC",
  d: "modelD",
};

export function createSandboxComparisonSelection<T>(value: T): SandboxComparisonSelection<T> {
  return {
    a: value,
    b: value,
    c: value,
    d: value,
  };
}

export function getActiveSandboxComparisonSlots(
  selection: SandboxComparisonSelection<string | null>,
): SandboxComparisonSlot[] {
  return SANDBOX_COMPARISON_SLOTS.filter((slot) => Boolean(selection[slot]));
}

export function normalizeSandboxComparisonSelection(
  availableModelKeys: string[],
  requested: Partial<SandboxComparisonSelection<string | null | undefined>>,
): SandboxComparisonSelection<string | null> {
  const available = new Set(availableModelKeys);
  const used = new Set<string>();
  const selectedKeys: string[] = [];

  for (const slot of SANDBOX_COMPARISON_SLOTS) {
    const requestedKey = requested[slot];
    if (requestedKey && available.has(requestedKey) && !used.has(requestedKey)) {
      selectedKeys.push(requestedKey);
      used.add(requestedKey);
    }
  }

  while (selectedKeys.length < 2) {
    const fallback = availableModelKeys.find((key) => !used.has(key));
    if (!fallback) break;
    selectedKeys.push(fallback);
    used.add(fallback);
  }

  const selection = createSandboxComparisonSelection<string | null>(null);
  for (const [index, modelKey] of selectedKeys.entries()) {
    const slot = SANDBOX_COMPARISON_SLOTS[index];
    if (slot) selection[slot] = modelKey;
  }
  return selection;
}
