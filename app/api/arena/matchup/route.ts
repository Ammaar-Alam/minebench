import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { ArenaMatchup } from "@/lib/arena/types";
import { weightedPick } from "@/lib/arena/sampling";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";
const ARENA_GRID_SIZE = 256;
const ARENA_PALETTE = "simple";
const ARENA_MODE = "precise";

type EligiblePrompt = { id: string; text: string };

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

function randomPick<T>(items: T[]): T | null {
  return items.length ? (items[Math.floor(Math.random() * items.length)] ?? null) : null;
}

async function getEligiblePrompts(): Promise<EligiblePrompt[]> {
  const rows = await prisma.build.groupBy({
    by: ["promptId", "modelId"],
    where: {
      gridSize: ARENA_GRID_SIZE,
      palette: ARENA_PALETTE,
      mode: ARENA_MODE,
      model: { enabled: true, isBaseline: false },
      prompt: { active: true },
    },
  });

  const modelsByPromptId = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = modelsByPromptId.get(r.promptId) ?? new Set<string>();
    set.add(r.modelId);
    modelsByPromptId.set(r.promptId, set);
  }

  const eligiblePromptIds = Array.from(modelsByPromptId.entries())
    .filter(([, models]) => models.size >= 2)
    .map(([promptId]) => promptId);

  if (eligiblePromptIds.length === 0) return [];

  return await prisma.prompt.findMany({
    where: { id: { in: eligiblePromptIds }, active: true },
    select: { id: true, text: true },
  });
}

async function getEligiblePromptById(promptId: string): Promise<EligiblePrompt | null> {
  const prompt = await prisma.prompt.findFirst({
    where: { id: promptId, active: true },
    select: { id: true, text: true },
  });
  if (!prompt) return null;

  const models = await prisma.build.groupBy({
    by: ["modelId"],
    where: {
      promptId,
      gridSize: ARENA_GRID_SIZE,
      palette: ARENA_PALETTE,
      mode: ARENA_MODE,
      model: { enabled: true, isBaseline: false },
    },
  });

  if (models.length < 2) return null;
  return prompt;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const promptId = url.searchParams.get("promptId") ?? undefined;

  const requestedPrompt = promptId ? await getEligiblePromptById(promptId) : null;
  const eligible = requestedPrompt ? [] : await getEligiblePrompts();
  const prompt = requestedPrompt ?? randomPick(eligible);

  if (!prompt) {
    return NextResponse.json(
      { error: "No seeded prompts found. Seed curated prompts/builds first." },
      { status: 409 }
    );
  }

  const models = await prisma.model.findMany({
    where: {
      enabled: true,
      isBaseline: false,
      builds: {
        some: {
          promptId: prompt.id,
          gridSize: ARENA_GRID_SIZE,
          palette: ARENA_PALETTE,
          mode: ARENA_MODE,
        },
      },
    },
    select: {
      id: true,
      key: true,
      provider: true,
      displayName: true,
      eloRating: true,
      shownCount: true,
    },
  });

  if (models.length < 2) {
    return NextResponse.json(
      { error: "Not enough seeded builds for this prompt yet." },
      { status: 409 }
    );
  }

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

  const [buildA, buildB] = await Promise.all([
    prisma.build.findFirst({
      where: {
        promptId: prompt.id,
        modelId: modelA.id,
        gridSize: ARENA_GRID_SIZE,
        palette: ARENA_PALETTE,
        mode: ARENA_MODE,
      },
      select: { id: true, voxelData: true },
    }),
    prisma.build.findFirst({
      where: {
        promptId: prompt.id,
        modelId: modelB.id,
        gridSize: ARENA_GRID_SIZE,
        palette: ARENA_PALETTE,
        mode: ARENA_MODE,
      },
      select: { id: true, voxelData: true },
    }),
  ]);

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

    await Promise.all([
      tx.model.update({
        where: { id: modelA.id },
        data: { shownCount: { increment: 1 } },
      }),
      tx.model.update({
        where: { id: modelB.id },
        data: { shownCount: { increment: 1 } },
      }),
    ]);

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
