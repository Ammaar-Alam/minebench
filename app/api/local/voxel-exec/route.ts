import { NextResponse } from "next/server";
import { z } from "zod";
import { maxBlocksForGrid } from "@/lib/ai/limits";
import { runVoxelExec } from "@/lib/ai/tools/voxelExec";
import { getPalette } from "@/lib/blocks/palettes";
import { validateVoxelBuild } from "@/lib/voxel/validate";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().min(1),
  gridSize: z.union([z.literal(64), z.literal(256), z.literal(512)]),
  palette: z.union([z.literal("simple"), z.literal("advanced")]),
  seed: z.number().int().optional(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    const raw = (await req.json()) as unknown;
    body = bodySchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid voxel.exec payload" }, { status: 400 });
  }

  try {
    const run = runVoxelExec({
      code: body.code,
      gridSize: body.gridSize,
      palette: body.palette,
      seed: body.seed,
    });

    const validated = validateVoxelBuild(run.build, {
      gridSize: body.gridSize,
      palette: getPalette(body.palette),
      maxBlocks: maxBlocksForGrid(body.gridSize),
    });
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    return NextResponse.json({
      build: validated.value.build,
      warnings: validated.value.warnings,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tool execution failed" },
      { status: 400 },
    );
  }
}
