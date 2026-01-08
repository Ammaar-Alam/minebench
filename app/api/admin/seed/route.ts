import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CURATED_PROMPTS } from "@/lib/arena/curatedPrompts";
import { MODEL_CATALOG, ModelKey } from "@/lib/ai/modelCatalog";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";

export const runtime = "nodejs";

function requireAdmin(req: Request): string | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return "Missing ADMIN_TOKEN on server";

  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "Missing Authorization header";
  if (match[1] !== token) return "Invalid token";
  return null;
}

const ARENA_SETTINGS = {
  gridSize: 32 as const,
  palette: "simple" as const,
  mode: "precise" as const,
};

const MAX_BATCH = 3;

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const url = new URL(req.url);
  const batchSizeRaw = Number(url.searchParams.get("batchSize") ?? "2");
  const batchSize = Math.max(1, Math.min(MAX_BATCH, Number.isFinite(batchSizeRaw) ? batchSizeRaw : 2));

  await prisma.$transaction(async (tx) => {
    await tx.model.upsert({
      where: { key: "baseline" },
      create: {
        key: "baseline",
        provider: "baseline",
        modelId: "baseline",
        displayName: "Baseline",
        enabled: false,
        isBaseline: true,
        eloRating: 1500,
      },
      update: {},
    });

    for (const m of MODEL_CATALOG) {
      await tx.model.upsert({
        where: { key: m.key },
        create: {
          key: m.key,
          provider: m.provider,
          modelId: m.modelId,
          displayName: m.displayName,
          enabled: m.enabled,
          isBaseline: false,
          eloRating: 1500,
        },
        update: {
          provider: m.provider,
          modelId: m.modelId,
          displayName: m.displayName,
          enabled: m.enabled,
        },
      });
    }

    for (const text of CURATED_PROMPTS) {
      await tx.prompt.upsert({
        where: { text },
        create: { text, active: true },
        update: { active: true },
      });
    }
  });

  const prompts = await prisma.prompt.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });

  const models = await prisma.model.findMany({
    where: { enabled: true, isBaseline: false },
    orderBy: { createdAt: "asc" },
  });

  const existing = await prisma.build.findMany({
    where: {
      gridSize: ARENA_SETTINGS.gridSize,
      palette: ARENA_SETTINGS.palette,
      mode: ARENA_SETTINGS.mode,
      promptId: { in: prompts.map((p) => p.id) },
      modelId: { in: models.map((m) => m.id) },
    },
    select: { promptId: true, modelId: true },
  });

  const existingSet = new Set(existing.map((b) => `${b.promptId}:${b.modelId}`));
  const pending: { promptId: string; promptText: string; modelId: string; modelKey: ModelKey }[] = [];

  for (const p of prompts) {
    for (const m of models) {
      const key = `${p.id}:${m.id}`;
      if (existingSet.has(key)) continue;
      pending.push({ promptId: p.id, promptText: p.text, modelId: m.id, modelKey: m.key as ModelKey });
      if (pending.length >= batchSize) break;
    }
    if (pending.length >= batchSize) break;
  }

  if (pending.length === 0) {
    return NextResponse.json({ ok: true, done: true, seeded: 0 });
  }

  let seeded = 0;
  for (const job of pending) {
    const r = await generateVoxelBuild({
      modelKey: job.modelKey,
      prompt: job.promptText,
      gridSize: ARENA_SETTINGS.gridSize,
      palette: ARENA_SETTINGS.palette,
    });

    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: r.error, modelKey: job.modelKey, prompt: job.promptText },
        { status: 502 }
      );
    }

    await prisma.build.create({
      data: {
        promptId: job.promptId,
        modelId: job.modelId,
        gridSize: ARENA_SETTINGS.gridSize,
        palette: ARENA_SETTINGS.palette,
        mode: ARENA_SETTINGS.mode,
        voxelData: r.build,
        blockCount: r.blockCount,
        generationTimeMs: r.generationTimeMs,
      },
    });

    seeded += 1;
  }

  return NextResponse.json({
    ok: true,
    done: false,
    seeded,
    remainingEstimate: "Run again to continue seeding",
  });
}
