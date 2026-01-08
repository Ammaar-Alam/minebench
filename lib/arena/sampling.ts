export function weightedPick<T>(items: T[], weight: (t: T) => number): T | null {
  if (items.length === 0) return null;
  const weights = items.map(weight);
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)] ?? null;

  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return items[i] ?? null;
  }
  return items[items.length - 1] ?? null;
}

