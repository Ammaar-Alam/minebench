import { geolocation, ipAddress } from "@vercel/functions";
import type { VoteChoice } from "@/lib/arena/types";

function clean(value: string | undefined | null, maxLength = 256): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

export function logArenaVoteRequest(
  request: Request,
  input: {
    outcome: "accepted" | "duplicate";
    voteId: string | null;
    choice: VoteChoice;
    authenticated: boolean;
    owned: boolean;
    scope: "public" | "private";
  },
): void {
  try {
    const geo = geolocation(request);
    console.info(JSON.stringify({
      event: "arena_vote",
      ...input,
      ip: clean(ipAddress(request), 64),
      country: clean(geo.country, 8),
      country_region: clean(geo.countryRegion, 64),
      city: clean(geo.city, 160),
      postal_code: clean(geo.postalCode, 32),
      latitude: clean(geo.latitude, 32),
      longitude: clean(geo.longitude, 32),
      edge_region: clean(geo.region, 32),
      request_id: clean(request.headers.get("x-vercel-id"), 160),
      user_agent: clean(request.headers.get("user-agent"), 256),
    }));
  } catch {
    // Logging must never change the vote response
  }
}
