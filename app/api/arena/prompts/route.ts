import { NextResponse } from "next/server";
import type { PromptListResponse } from "@/lib/arena/types";
import { listArenaEligiblePrompts } from "@/lib/arena/eligibility";

export const runtime = "nodejs";

export async function GET() {
  try {
    const prompts = await listArenaEligiblePrompts();

    const body: PromptListResponse = { prompts };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load prompts";
    return NextResponse.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
