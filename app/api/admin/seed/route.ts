import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CURATED_PROMPTS } from "@/lib/arena/curatedPrompts";
import { MODEL_CATALOG, ModelKey } from "@/lib/ai/modelCatalog";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";

export const runtime = "nodejs";

function requireAdmin(req: Request): string | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return "Missing ADMIN_TOKEN on server";

  const auth = req.headers.get("authorization");
  if (!auth) return "Missing Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";

  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return "Invalid Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";
  }

  const presented = match[1]?.trim();
  if (!presented) {
    return "Empty Bearer token (did you set $ADMIN_TOKEN when running curl?)";
  }
  if (presented !== token.trim()) {
    return "Invalid token (must match ADMIN_TOKEN; note Next.js dev loads .env.local before .env)";
  }
  return null;
}

function getDbInfo() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "");
    const pgbouncer = u.searchParams.get("pgbouncer") === "true";

    return {
      host: u.hostname,
      port: u.port || "5432",
      database,
      pgbouncer,
    };
  } catch {
    return { host: "unknown", port: "unknown", database: "unknown", pgbouncer: false };
  }
}

function providerKeyStatus() {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    gemini: Boolean(process.env.GOOGLE_AI_API_KEY),
  };
}

function isProviderConfigured(provider: string) {
  const status = providerKeyStatus();
  if (provider === "openai") return status.openai;
  if (provider === "anthropic") return status.anthropic;
  if (provider === "gemini") return status.gemini;
  return true;
}

const ARENA_SETTINGS = {
  gridSize: 64 as const,
  palette: "simple" as const,
  mode: "precise" as const,
};

const MAX_BATCH = 3;
const FALSE_VALUES = new Set(["0", "false", "no"]);
const TRUE_VALUES = new Set(["1", "true", "yes"]);

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const url = new URL(req.url);
  const runId = crypto.randomUUID().slice(0, 8);
  const dryRun = TRUE_VALUES.has((url.searchParams.get("dryRun") ?? "").trim().toLowerCase());
  const generateBuilds = !FALSE_VALUES.has((url.searchParams.get("generateBuilds") ?? "").trim().toLowerCase());
  const batchSizeRaw = Number(url.searchParams.get("batchSize") ?? "2");
  const batchSize = Math.max(1, Math.min(MAX_BATCH, Number.isFinite(batchSizeRaw) ? batchSizeRaw : 2));
  const keyStatus = providerKeyStatus();

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
      const enabled = m.enabled && isProviderConfigured(m.provider);
      await tx.model.upsert({
        where: { key: m.key },
        create: {
          key: m.key,
          provider: m.provider,
          modelId: m.modelId,
          displayName: m.displayName,
          enabled,
          isBaseline: false,
          eloRating: 1500,
        },
        update: {
          provider: m.provider,
          modelId: m.modelId,
          displayName: m.displayName,
          enabled,
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

  if (!generateBuilds) {
    const [promptCount, modelCount] = await Promise.all([
      prisma.prompt.count({ where: { active: true } }),
      prisma.model.count({ where: { enabled: true, isBaseline: false } }),
    ]);

    return NextResponse.json({
      ok: true,
      done: true,
      seeded: 0,
      promptCount,
      modelCount,
      settings: ARENA_SETTINGS,
      db: getDbInfo(),
      providerKeys: keyStatus,
      runId,
    });
  }

  const prompts = await prisma.prompt.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });

  const models = await prisma.model.findMany({
    where: { enabled: true, isBaseline: false },
    orderBy: { createdAt: "asc" },
  });

  if (prompts.length === 0) {
    return NextResponse.json({
      ok: false,
      done: true,
      seeded: 0,
      error: "No active prompts found. Add prompts to CURATED_PROMPTS and rerun seed.",
      promptCount: 0,
      modelCount: models.length,
      settings: ARENA_SETTINGS,
      db: getDbInfo(),
      providerKeys: keyStatus,
      runId,
    });
  }

  if (models.length === 0) {
    return NextResponse.json({
      ok: false,
      done: true,
      seeded: 0,
      error:
        "No enabled models found. Set at least one provider API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY) or enable models for configured providers.",
      promptCount: prompts.length,
      modelCount: 0,
      settings: ARENA_SETTINGS,
      db: getDbInfo(),
      providerKeys: keyStatus,
      runId,
    });
  }

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
  const totalExpectedBuilds = prompts.length * models.length;
  const existingBuilds = existingSet.size;
  const remainingBefore = Math.max(0, totalExpectedBuilds - existingBuilds);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      done: remainingBefore === 0,
      seeded: 0,
      promptCount: prompts.length,
      modelCount: models.length,
      totalExpectedBuilds,
      existingBuilds,
      remainingBuilds: remainingBefore,
      settings: ARENA_SETTINGS,
      db: getDbInfo(),
      providerKeys: keyStatus,
      runId,
    });
  }

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
    return NextResponse.json({
      ok: true,
      done: true,
      seeded: 0,
      promptCount: prompts.length,
      modelCount: models.length,
      totalExpectedBuilds,
      existingBuilds,
      remainingBuilds: remainingBefore,
      settings: ARENA_SETTINGS,
      db: getDbInfo(),
      providerKeys: keyStatus,
      runId,
    });
  }

  let seeded = 0;
  const startedAt = Date.now();
  console.log(`[seed:${runId}] starting batch (size=${pending.length}, remaining≈${remainingBefore})`);

  const seededJobs: { promptId: string; modelKey: ModelKey }[] = [];
  for (const [idx, job] of pending.entries()) {
    console.log(
      `[seed:${runId}] generating ${idx + 1}/${pending.length} model=${job.modelKey} promptId=${job.promptId}`
    );

    const r = await generateVoxelBuild({
      modelKey: job.modelKey,
      prompt: job.promptText,
      gridSize: ARENA_SETTINGS.gridSize,
      palette: ARENA_SETTINGS.palette,
    });

    if (!r.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: r.error,
          modelKey: job.modelKey,
          promptId: job.promptId,
          prompt: job.promptText,
          settings: ARENA_SETTINGS,
          db: getDbInfo(),
          providerKeys: keyStatus,
          runId,
        },
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
    seededJobs.push({ promptId: job.promptId, modelKey: job.modelKey });
  }

  const durationMs = Date.now() - startedAt;
  const remainingAfter = Math.max(0, remainingBefore - seeded);
  console.log(`[seed:${runId}] batch complete (seeded=${seeded}, remaining≈${remainingAfter}, durationMs=${durationMs})`);

  return NextResponse.json({
    ok: true,
    done: false,
    seeded,
    promptCount: prompts.length,
    modelCount: models.length,
    totalExpectedBuilds,
    existingBuilds,
    remainingBuilds: remainingAfter,
    seededJobs,
    durationMs,
    settings: ARENA_SETTINGS,
    db: getDbInfo(),
    providerKeys: keyStatus,
    remainingEstimate: "Run again to continue seeding",
    runId,
  });
}
