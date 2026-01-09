import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPalette } from "@/lib/blocks/palettes";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import { maxBlocksForGrid } from "@/lib/ai/generateVoxelBuild";

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

const querySchema = z.object({
  modelKey: z.string().min(1),
  promptId: z.string().min(1),
  overwrite: z
    .union([z.literal("1"), z.literal("true"), z.literal("yes"), z.literal("0"), z.literal("false"), z.literal("no")])
    .optional(),
  gridSize: z.union([z.literal("32"), z.literal("64"), z.literal("128")]).optional(),
  palette: z.union([z.literal("simple"), z.literal("advanced")]).optional(),
  mode: z.string().min(1).optional(),
});

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsedQuery.success) {
    return NextResponse.json({ error: parsedQuery.error.message }, { status: 400 });
  }

  const { modelKey, promptId } = parsedQuery.data;
  const overwrite = truthy(parsedQuery.data.overwrite);
  const gridSize = Number(parsedQuery.data.gridSize ?? "64") as 32 | 64 | 128;
  const palette = (parsedQuery.data.palette ?? "simple") as "simple" | "advanced";
  const mode = parsedQuery.data.mode ?? "precise";

  const model = await prisma.model.findUnique({ where: { key: modelKey } });
  if (!model) return NextResponse.json({ error: `Unknown modelKey: ${modelKey}` }, { status: 404 });
  if (model.isBaseline) return NextResponse.json({ error: "Cannot import builds for baseline model" }, { status: 400 });

  const prompt = await prisma.prompt.findUnique({ where: { id: promptId } });
  if (!prompt) return NextResponse.json({ error: `Unknown promptId: ${promptId}` }, { status: 404 });

  const json = (await req.json().catch(() => null)) as unknown;
  if (!json) return NextResponse.json({ error: "Missing JSON request body" }, { status: 400 });

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
    promptId: prompt.id,
    modelKey: model.key,
    settings: { gridSize, palette, mode },
    blockCount,
    warnings: validated.value.warnings,
    overwritten: Boolean(existing),
  });
}

