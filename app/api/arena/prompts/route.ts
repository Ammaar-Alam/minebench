import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { PromptListResponse } from "@/lib/arena/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const prompts = await prisma.prompt.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, text: true },
    });

    const body: PromptListResponse = { prompts };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load prompts";
    return NextResponse.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
