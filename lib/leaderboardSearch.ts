import type { LeaderboardResponse } from "@/lib/arena/types";

type SearchableLeaderboardModel = Pick<
  LeaderboardResponse["models"][number],
  "displayName" | "provider"
>;

export function matchesLeaderboardModelQuery(
  model: SearchableLeaderboardModel,
  query: string,
): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const searchableText = `${model.displayName} ${model.provider}`.toLowerCase();
  return tokens.every((token) => searchableText.includes(token));
}
