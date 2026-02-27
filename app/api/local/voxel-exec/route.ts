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

const MAX_CODE_CHARS = 600_000;

function isEndpointEnabledForEnv() {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.MINEBENCH_ENABLE_LOCAL_EXEC_API === "1";
}

function isSameOriginRequest(req: Request) {
  const candidate = req.headers.get("origin") ?? req.headers.get("referer");
  if (!candidate) return false;

  try {
    const originUrl = new URL(candidate);
    const reqUrl = new URL(req.url);
    return originUrl.protocol === reqUrl.protocol && originUrl.host === reqUrl.host;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!isEndpointEnabledForEnv()) {
    return NextResponse.json(
      {
        error:
          "Local voxel.exec endpoint is disabled in production. Set MINEBENCH_ENABLE_LOCAL_EXEC_API=1 to enable.",
      },
      { status: 403 },
    );
  }

  if (process.env.NODE_ENV === "production") {
    if (!isSameOriginRequest(req)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const fetchSite = req.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = (await req.json()) as unknown;
    body = bodySchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid voxel.exec payload" }, { status: 400 });
  }

  if (body.code.length > MAX_CODE_CHARS) {
    return NextResponse.json(
      { error: `Code payload too large (${body.code.length} chars > ${MAX_CODE_CHARS})` },
      { status: 413 },
    );
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
