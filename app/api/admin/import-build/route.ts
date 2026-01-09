import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { getPalette } from "@/lib/blocks/palettes";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";
import { maxBlocksForGrid } from "@/lib/ai/generateVoxelBuild";

export const runtime = "nodejs";

const ARENA_DEFAULTS = {
  gridSize: 64 as const,
  palette: "simple" as const,
  mode: "precise" as const,
};

const TRUE_VALUES = new Set(["1", "true", "yes"]);

const MIN_BLOCKS_BY_GRID: Record<32 | 64 | 128, number> = {
  32: 80,
  64: 200,
  128: 300,
};

function requireAdmin(req: Request): string | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return "Missing ADMIN_TOKEN on server";

  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "Missing Authorization header";
  const presented = match[1].trim();
  if (presented !== token.trim()) {
    return "Invalid token (must match ADMIN_TOKEN; note Next.js dev loads .env.local before .env)";
  }
  return null;
}

function parseGridSize(value: string | null, fallback: 32 | 64 | 128) {
  if (!value) return fallback;
  const n = Number(value);
  if (n === 32 || n === 64 || n === 128) return n;
  return null;
}

function buildBounds(build: VoxelBuild) {
  if (build.blocks.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const b of build.blocks) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.x > maxX) maxX = b.x;
    if (b.y > maxY) maxY = b.y;
    if (b.z > maxZ) maxZ = b.z;
  }

  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const spanZ = maxZ - minZ + 1;
  return { minX, minY, minZ, maxX, maxY, maxZ, spanX, spanY, spanZ };
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ ok: false, error: denied }, { status: 401 });

  const url = new URL(req.url);
  const overwrite = TRUE_VALUES.has((url.searchParams.get("overwrite") ?? "").trim().toLowerCase());

  const modelKeyRaw = (url.searchParams.get("modelKey") ?? "").trim();
  if (!modelKeyRaw) {
    return NextResponse.json({ ok: false, error: "Missing required query param: modelKey" }, { status: 400 });
  }

  let modelKey: ModelKey;
  try {
    modelKey = modelKeyRaw as ModelKey;
    getModelByKey(modelKey);
  } catch {
    return NextResponse.json(
      { ok: false, error: `Unknown modelKey: ${modelKeyRaw}` },
      { status: 400 }
    );
  }

  const promptIdParam = (url.searchParams.get("promptId") ?? "").trim();
  const promptTextParam = (url.searchParams.get("promptText") ?? "").trim();
  if (!promptIdParam && !promptTextParam) {
    return NextResponse.json(
      { ok: false, error: "Missing required query param: promptId or promptText" },
      { status: 400 }
    );
  }

  const gridSize = parseGridSize(url.searchParams.get("gridSize"), ARENA_DEFAULTS.gridSize);
  if (!gridSize) {
    return NextResponse.json(
      { ok: false, error: "Invalid gridSize (allowed: 32, 64, 128)" },
      { status: 400 }
    );
  }

  const paletteRaw = (url.searchParams.get("palette") ?? ARENA_DEFAULTS.palette).trim().toLowerCase();
  if (paletteRaw !== "simple" && paletteRaw !== "advanced") {
    return NextResponse.json(
      { ok: false, error: "Invalid palette (allowed: simple, advanced)" },
      { status: 400 }
    );
  }
  const palette = paletteRaw as "simple" | "advanced";
  const mode = (url.searchParams.get("mode") ?? ARENA_DEFAULTS.mode).trim();
  if (!mode) {
    return NextResponse.json({ ok: false, error: "Invalid mode (must be non-empty)" }, { status: 400 });
  }

  const raw = await req.text();
  if (!raw.trim()) {
    return NextResponse.json({ ok: false, error: "Request body is empty (expected voxel build JSON)" }, { status: 400 });
  }

  const parsed = extractBestVoxelBuildJson(raw);
  if (!parsed) {
    return NextResponse.json(
      { ok: false, error: "Could not find a valid JSON object in the request body" },
      { status: 400 }
    );
  }

  const paletteDefs = getPalette(palette);
  const maxBlocks = maxBlocksForGrid(gridSize);
  const validated = validateVoxelBuild(parsed, { palette: paletteDefs, gridSize, maxBlocks });
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  const minBlocks = MIN_BLOCKS_BY_GRID[gridSize];
  if (validated.value.build.blocks.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "No valid blocks after validation. Use ONLY in-bounds coordinates and ONLY block IDs from the available list.",
        warnings: validated.value.warnings,
      },
      { status: 400 }
    );
  }

  if (validated.value.build.blocks.length < minBlocks) {
    return NextResponse.json(
      {
        ok: false,
        error: `Build too small (${validated.value.build.blocks.length} blocks). Create at least ~${minBlocks} blocks so the result is recognizable.`,
        warnings: validated.value.warnings,
      },
      { status: 400 }
    );
  }

  const bounds = buildBounds(validated.value.build);
  if (bounds) {
    const minFootprint = Math.max(6, Math.floor(gridSize * 0.55));
    const minHeight = Math.max(4, Math.floor(gridSize * 0.14));
    const maxFootprintSpan = Math.max(bounds.spanX, bounds.spanZ);

    if (maxFootprintSpan < minFootprint) {
      return NextResponse.json(
        {
          ok: false,
          error: `Build footprint too small (span ${maxFootprintSpan}). Expand the build to span at least ~${minFootprint} blocks across x or z for more detail.`,
          warnings: validated.value.warnings,
        },
        { status: 400 }
      );
    }

    if (bounds.spanY < minHeight) {
      return NextResponse.json(
        {
          ok: false,
          error: `Build height too small (span ${bounds.spanY}). Add more vertical structure (span at least ~${minHeight}) so it reads clearly.`,
          warnings: validated.value.warnings,
        },
        { status: 400 }
      );
    }
  }

  const modelEntry = getModelByKey(modelKey);
  const model = await prisma.model.upsert({
    where: { key: modelEntry.key },
    create: {
      key: modelEntry.key,
      provider: modelEntry.provider,
      modelId: modelEntry.modelId,
      displayName: modelEntry.displayName,
      enabled: true,
      isBaseline: false,
    },
    update: {
      provider: modelEntry.provider,
      modelId: modelEntry.modelId,
      displayName: modelEntry.displayName,
      enabled: true,
    },
  });

  const prompt = promptIdParam
    ? await prisma.prompt.findFirst({ where: { id: promptIdParam } })
    : await prisma.prompt.upsert({
        where: { text: promptTextParam },
        create: { text: promptTextParam, active: true },
        update: { active: true },
      });

  if (!prompt) {
    return NextResponse.json(
      { ok: false, error: `Prompt not found: ${promptIdParam}` },
      { status: 404 }
    );
  }

  if (!prompt.active) {
    await prisma.prompt.update({ where: { id: prompt.id }, data: { active: true } });
  }

  const existing = await prisma.build.findFirst({
    where: {
      promptId: prompt.id,
      modelId: model.id,
      gridSize,
      palette,
      mode,
    },
    select: { id: true },
  });

  if (existing && !overwrite) {
    return NextResponse.json(
      {
        ok: false,
        error: "Build already exists for this prompt/model/settings. Re-run with overwrite=1 to replace it.",
        buildId: existing.id,
      },
      { status: 409 }
    );
  }

  const data = {
    promptId: prompt.id,
    modelId: model.id,
    gridSize,
    palette,
    mode,
    voxelData: validated.value.build,
    blockCount: validated.value.build.blocks.length,
    generationTimeMs: 0,
  };

  const saved = existing
    ? await prisma.build.update({ where: { id: existing.id }, data })
    : await prisma.build.create({ data });

  return NextResponse.json(
    {
      ok: true,
      created: !existing,
      overwritten: Boolean(existing),
      buildId: saved.id,
      prompt: { id: prompt.id, text: prompt.text },
      model: {
        id: model.id,
        key: model.key,
        provider: model.provider,
        displayName: model.displayName,
      },
      settings: { gridSize, palette, mode },
      blockCount: data.blockCount,
      warnings: validated.value.warnings,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

