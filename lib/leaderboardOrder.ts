/**
 * shared reader for the current leaderboard ordering.
 *
 * the leaderboard page writes its full response to the mb-leaderboard-v1
 * sessionStorage entry (via staleCache). we piggyback on that cache so the
 * model-detail page can show prev/next arrows without doing its own fetch
 * whenever the user arrived from the leaderboard. if the cache is empty
 * (direct url hit, different tab), we fall back to /api/leaderboard.
 *
 * canonical order matches the api: conservativeRating desc, displayName asc.
 */
import type { LeaderboardResponse } from "@/lib/arena/types";
import { readStale } from "@/lib/staleCache";

const LEADERBOARD_CACHE_KEY = "mb-leaderboard-v1";
const LEADERBOARD_STALE_MAX_AGE_MS = 10 * 60 * 1000;

export function readLeaderboardOrderFromCache(): string[] | null {
  const cached = readStale<LeaderboardResponse>(
    LEADERBOARD_CACHE_KEY,
    LEADERBOARD_STALE_MAX_AGE_MS,
  );
  if (!cached.value || !cached.isFresh) return null;
  const keys = cached.value.models
    .map((m) => m.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  return keys.length > 0 ? keys : null;
}

export async function fetchLeaderboardOrder(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch("/api/leaderboard", { signal });
  if (!res.ok) throw new Error(`leaderboard fetch failed: ${res.status}`);
  const json = (await res.json()) as LeaderboardResponse;
  return json.models
    .map((m) => m.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}
