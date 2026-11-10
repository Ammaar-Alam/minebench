import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseArenaMatchupToken } from "@/lib/arena/matchupToken";
import { readArenaSessionId } from "@/lib/arena/session";
import { ARENA_VOTE_REASON_KEYS } from "@/lib/arena/voteReasons";

export const runtime = "nodejs";

const reqSchema = z.object({
  matchupId: z.string().min(1).max(2048),
  reasons: z.array(z.enum(ARENA_VOTE_REASON_KEYS)).max(ARENA_VOTE_REASON_KEYS.length),
});

export async function POST(req: Request) {
  const parsed = reqSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const matchup = parseArenaMatchupToken(parsed.data.matchupId);
  const sessionId = readArenaSessionId(req.headers.get("cookie"));
  // a blocked voter has no saved vote, so this matches nothing for them
  if (matchup && sessionId) {
    await prisma.vote.updateMany({
      where: { matchupId: matchup.id, sessionId, choice: { in: ["A", "B"] } },
      data: { reasons: [...new Set(parsed.data.reasons)], reasonsAt: new Date() },
    });
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
