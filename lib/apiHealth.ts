/**
 * session-scoped "is the site healthy right now?" signal.
 *
 * pattern: fetchWithRetry reports failures + successes here. if we see
 * multiple failures across any endpoint within the watch window, we flag
 * the session as degraded so a global banner can surface it.
 *
 * this complements per-surface error states — the goal is to give users
 * a consistent "yes, MineBench is having trouble right now" signal
 * even as they navigate between pages that each have their own errors.
 */

import { useSyncExternalStore } from "react";

const FAILURE_WATCH_WINDOW_MS = 30_000;
const FAILURES_TO_DEGRADE = 2;
const DEGRADED_MIN_VISIBLE_MS = 6_000;

type FailureEntry = {
  endpoint: string;
  at: number;
};

type Health = {
  degraded: boolean;
  failureCount: number;
  lastFailureAt: number | null;
};

const failures: FailureEntry[] = [];
let degradedSince: number | null = null;
let health: Health = { degraded: false, failureCount: 0, lastFailureAt: null };
const listeners = new Set<() => void>();
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

function pruneFailures(now: number): void {
  const cutoff = now - FAILURE_WATCH_WINDOW_MS;
  while (failures.length > 0 && failures[0]!.at < cutoff) {
    failures.shift();
  }
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* swallow — a failing subscriber shouldn't break health tracking */
    }
  }
}

function scheduleRecoveryCheck(delayMs: number): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    const now = Date.now();
    pruneFailures(now);
    updateHealth(now);
  }, delayMs);
}

function updateHealth(now: number): void {
  const failureCount = failures.length;
  const lastFailureAt = failures.length > 0 ? failures[failures.length - 1]!.at : null;

  let degraded = health.degraded;
  if (failureCount >= FAILURES_TO_DEGRADE) {
    if (!degraded) {
      degraded = true;
      degradedSince = now;
    }
  } else if (degraded) {
    // hold the banner on screen for at least DEGRADED_MIN_VISIBLE_MS so it
    // doesn't flash on and off on a single transient error
    const visibleFor = degradedSince != null ? now - degradedSince : Infinity;
    if (visibleFor >= DEGRADED_MIN_VISIBLE_MS) {
      degraded = false;
      degradedSince = null;
    } else {
      scheduleRecoveryCheck(DEGRADED_MIN_VISIBLE_MS - visibleFor);
    }
  }

  const next: Health = { degraded, failureCount, lastFailureAt };
  const changed =
    next.degraded !== health.degraded ||
    next.failureCount !== health.failureCount ||
    next.lastFailureAt !== health.lastFailureAt;
  health = next;
  if (changed) emit();
}

export function recordApiFailure(endpoint: string): void {
  const now = Date.now();
  pruneFailures(now);
  failures.push({ endpoint, at: now });
  updateHealth(now);
  // schedule a re-check when this failure ages out of the window
  scheduleRecoveryCheck(FAILURE_WATCH_WINDOW_MS + 100);
}

export function recordApiSuccess(endpoint: string): void {
  if (failures.length === 0) return;
  // drop any failure entries for this endpoint — a success means it came back
  for (let i = failures.length - 1; i >= 0; i -= 1) {
    if (failures[i]!.endpoint === endpoint) failures.splice(i, 1);
  }
  const now = Date.now();
  pruneFailures(now);
  updateHealth(now);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Health {
  return health;
}

const SERVER_SNAPSHOT: Health = { degraded: false, failureCount: 0, lastFailureAt: null };
function getServerSnapshot(): Health {
  return SERVER_SNAPSHOT;
}

export function useSiteHealth(): Health {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** test-only reset hook — not exported publicly, but useful in dev tools */
export function __resetApiHealth(): void {
  failures.length = 0;
  degradedSince = null;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  health = { degraded: false, failureCount: 0, lastFailureAt: null };
  emit();
}
