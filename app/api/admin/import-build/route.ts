import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { getPalette } from "@/lib/blocks/palettes";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import { maxBlocksForGrid } from "@/lib/ai/generateVoxelBuild";
import { gunzipSync } from "node:zlib";

export const runtime = "nodejs";

function requireAdmin(req: Request): string | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return "Missing ADMIN_TOKEN on server";

  const auth = req.headers.get("authorization");
  if (!auth) return "Missing Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";

  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "Invalid Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";

  const presented = match[1]?.trim();
  if (!presented) return "Empty Bearer token (did you set $ADMIN_TOKEN when running curl?)";
  if (presented !== token.trim()) return "Invalid token (must match ADMIN_TOKEN)";
  return null;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

async function readRequestBodyText(req: Request): Promise<{ ok: true; text: string } | { ok: false; error: string; status: number }> {
  const encoding = (req.headers.get("content-encoding") ?? "").split(",")[0]?.trim().toLowerCase();
  const bytes = Buffer.from(await req.arrayBuffer());

  const isGzipMagic = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const wantsGzip = encoding === "gzip" || encoding === "x-gzip";

  if (wantsGzip || isGzipMagic) {
    // If a proxy strips Content-Encoding, sniff for gzip magic bytes so uploads still work.
    // If a platform decompresses but forgets to strip the header, avoid double-gunzipping.
    if (!isGzipMagic) return { ok: true, text: bytes.toString("utf-8") };

    try {
      const text = gunzipSync(bytes).toString("utf-8");
      return { ok: true, text };
    } catch {
      return { ok: false, error: "Invalid gzip request body", status: 400 };
    }
  }

  if (!encoding || encoding === "identity") {
    return { ok: true, text: bytes.toString("utf-8") };
  }

  return { ok: false, error: `Unsupported Content-Encoding: ${encoding}`, status: 415 };
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const url = new URL(req.url);
  const modelKeyRaw = (url.searchParams.get("modelKey") ?? "").trim();
  if (!modelKeyRaw) {
    return NextResponse.json({ error: "Missing required query param: modelKey" }, { status: 400 });
  }

  let modelKey: ModelKey;
  try {
    modelKey = modelKeyRaw as ModelKey;
    getModelByKey(modelKey);
  } catch {
    return NextResponse.json({ error: `Unknown modelKey: ${modelKeyRaw}` }, { status: 400 });
  }

  const promptId = (url.searchParams.get("promptId") ?? "").trim();
  const promptText = (url.searchParams.get("promptText") ?? "").trim();
  if (!promptId && !promptText) {
    return NextResponse.json({ error: "Missing required query param: promptId or promptText" }, { status: 400 });
  }

  const overwrite = truthy(url.searchParams.get("overwrite") ?? undefined);

  const gridSizeRaw = url.searchParams.get("gridSize");
  const gridSize = gridSizeRaw ? Number(gridSizeRaw) : 256;
  if (gridSize !== 64 && gridSize !== 256 && gridSize !== 512) {
    return NextResponse.json({ error: "Invalid gridSize (allowed: 64, 256, 512)" }, { status: 400 });
  }

  const palette = ((url.searchParams.get("palette") ?? "simple").trim().toLowerCase() as "simple" | "advanced");
  if (palette !== "simple" && palette !== "advanced") {
    return NextResponse.json({ error: "Invalid palette (allowed: simple, advanced)" }, { status: 400 });
  }

  const mode = (url.searchParams.get("mode") ?? "precise").trim();
  if (!mode) return NextResponse.json({ error: "Invalid mode (must be non-empty)" }, { status: 400 });

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

  if (model.isBaseline) {
    return NextResponse.json({ error: "Cannot import builds for baseline model" }, { status: 400 });
  }

  const prompt = promptId
    ? await prisma.prompt.findUnique({ where: { id: promptId } })
    : await prisma.prompt.upsert({
        where: { text: promptText },
        create: { text: promptText, active: true },
        update: { active: true },
      });

  if (!prompt) return NextResponse.json({ error: `Unknown promptId: ${promptId}` }, { status: 404 });
  if (!prompt.active) {
    await prisma.prompt.update({ where: { id: prompt.id }, data: { active: true } });
  }

  const rawBody = await readRequestBodyText(req);
  if (!rawBody.ok) {
    return NextResponse.json({ error: rawBody.error }, { status: rawBody.status });
  }

  const raw = rawBody.text;
  if (!raw.trim()) return NextResponse.json({ error: "Request body is empty (expected voxel build JSON)" }, { status: 400 });

  const json = extractBestVoxelBuildJson(raw);
  if (!json) {
    return NextResponse.json({ error: "Could not find a valid JSON object in the request body" }, { status: 400 });
  }

  const paletteDefs = getPalette(palette);
  const validated = validateVoxelBuild(json, {
    gridSize,
    palette: paletteDefs,
    maxBlocks: maxBlocksForGrid(gridSize),
  });
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  const blockCount = validated.value.build.blocks.length;

  const existing = await prisma.build.findFirst({
    where: { promptId: prompt.id, modelId: model.id, gridSize, palette, mode },
  });

  if (existing && !overwrite) {
    return NextResponse.json(
      { error: "Build already exists for (promptId, modelKey, gridSize, palette, mode). Use overwrite=1 to replace it." },
      { status: 409 }
    );
  }

  const saved = existing
    ? await prisma.build.update({
        where: { id: existing.id },
        data: {
          promptId: prompt.id,
          modelId: model.id,
          gridSize,
          palette,
          mode,
          voxelData: validated.value.build,
          blockCount,
          generationTimeMs: 0,
        },
      })
    : await prisma.build.create({
        data: {
          promptId: prompt.id,
          modelId: model.id,
          gridSize,
          palette,
          mode,
          voxelData: validated.value.build,
          blockCount,
          generationTimeMs: 0,
        },
      });

  return NextResponse.json({
    ok: true,
    buildId: saved.id,
    prompt: { id: prompt.id, text: prompt.text },
    model: { id: model.id, key: model.key, provider: model.provider, displayName: model.displayName },
    settings: { gridSize, palette, mode },
    blockCount,
    warnings: validated.value.warnings,
    overwritten: Boolean(existing),
  });
}
