/**
 * thin sessionStorage wrapper for stale-while-revalidate UX.
 *
 * we intentionally use sessionStorage (not localStorage) — cached ranking data
 * should not outlive the tab. first-party concern: don't ship a stale
 * leaderboard to a user who came back a day later expecting fresh data.
 */

type Entry<T> = {
  v: T;
  /** ms since epoch when written */
  t: number;
};

export type StaleRead<T> = {
  value: T | null;
  ageMs: number | null;
  isFresh: boolean;
};

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStale<T>(key: string, maxAgeMs: number): StaleRead<T> {
  const storage = getStorage();
  if (!storage) return { value: null, ageMs: null, isFresh: false };
  const raw = storage.getItem(key);
  if (!raw) return { value: null, ageMs: null, isFresh: false };
  try {
    const parsed = JSON.parse(raw) as Entry<T>;
    if (!parsed || typeof parsed.t !== "number") {
      return { value: null, ageMs: null, isFresh: false };
    }
    const ageMs = Date.now() - parsed.t;
    return { value: parsed.v, ageMs, isFresh: ageMs <= maxAgeMs };
  } catch {
    // bad JSON — forget it so we stop re-parsing
    try {
      storage.removeItem(key);
    } catch {
      /* noop */
    }
    return { value: null, ageMs: null, isFresh: false };
  }
}

export function writeStale<T>(key: string, value: T): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const entry: Entry<T> = { v: value, t: Date.now() };
    storage.setItem(key, JSON.stringify(entry));
  } catch {
    // storage quota exceeded or disabled — we just don't cache this round
  }
}

export function clearStale(key: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* noop */
  }
}

/** human-readable "N min ago" / "just now" */
export function formatAge(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return "";
  if (ageMs < 10_000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} min ago`;
  return `${Math.round(ageMs / 3_600_000)}h ago`;
}
