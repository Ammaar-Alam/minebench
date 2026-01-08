import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { ArenaMatchup } from "@/lib/arena/types";
import { weightedPick } from "@/lib/arena/sampling";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";

function getOrSetSessionId(res: NextResponse, req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const existing = match?.[1];
  if (existing) return existing;
  const id = crypto.randomUUID();
  res.cookies.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const promptId = url.searchParams.get("promptId") ?? undefined;

  const prompt =
    (promptId
      ? await prisma.prompt.findFirst({ where: { id: promptId, active: true } })
      : null) ??
    (await prisma.prompt.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } }));

  if (!prompt) {
    return NextResponse.json(
      { error: "No prompts found. Seed the database first." },
      { status: 409 }
    );
  }

  const builds = await prisma.build.findMany({
    where: {
      promptId: prompt.id,
      gridSize: 32,
      palette: "simple",
      mode: "precise",
      model: { enabled: true, isBaseline: false },
    },
    include: { model: true },
  });

  if (builds.length < 2) {
    return NextResponse.json(
      { error: "Not enough seeded builds for this prompt yet." },
      { status: 409 }
    );
  }

  const models = builds.map((b) => b.model);
  const pickWeight = (m: (typeof models)[number]) => 1 / (m.shownCount + 1);

  const modelA = weightedPick(models, pickWeight);
  const remaining = models.filter((m) => m.id !== modelA?.id);
  const modelB = weightedPick(remaining, pickWeight);

  if (!modelA || !modelB) {
    return NextResponse.json(
      { error: "Failed to sample matchup models" },
      { status: 500 }
    );
  }

  const buildA = builds.find((b) => b.modelId === modelA.id);
  const buildB = builds.find((b) => b.modelId === modelB.id);
  if (!buildA || !buildB) {
    return NextResponse.json({ error: "Missing seeded build" }, { status: 500 });
  }

  const created = await prisma.$transaction(async (tx) => {
    const matchup = await tx.matchup.create({
      data: {
        promptId: prompt.id,
        modelAId: modelA.id,
        modelBId: modelB.id,
        buildAId: buildA.id,
        buildBId: buildB.id,
      },
    });

    await tx.model.update({
      where: { id: modelA.id },
      data: { shownCount: { increment: 1 } },
    });
    await tx.model.update({
      where: { id: modelB.id },
      data: { shownCount: { increment: 1 } },
    });

    return matchup;
  });

  const body: ArenaMatchup = {
    id: created.id,
    prompt: { id: prompt.id, text: prompt.text },
    a: {
      model: {
        key: modelA.key,
        provider: modelA.provider,
        displayName: modelA.displayName,
        eloRating: Number(modelA.eloRating),
      },
      build: buildA.voxelData as ArenaMatchup["a"]["build"],
    },
    b: {
      model: {
        key: modelB.key,
        provider: modelB.provider,
        displayName: modelB.displayName,
        eloRating: Number(modelB.eloRating),
      },
      build: buildB.voxelData as ArenaMatchup["b"]["build"],
    },
  };

  const res = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  getOrSetSessionId(res, req);
  return res;
}
