import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { PromptListResponse } from "@/lib/arena/types";

export const runtime = "nodejs";

export async function GET() {
  const prompts = await prisma.prompt.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, text: true },
  });

  const body: PromptListResponse = { prompts };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

