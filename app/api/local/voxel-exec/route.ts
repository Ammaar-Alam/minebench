import { NextResponse } from "next/server";
import { z } from "zod";
import { maxBlocksForGrid, isGridSize, type GridSize } from "@/lib/ai/limits";
import { runVoxelExec } from "@/lib/ai/tools/voxelExec";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { getPalette } from "@/lib/blocks/palettes";
import { createCustomBuildProcessingGate } from "@/lib/custom-builds/processingGate";
import { getErrorMessage } from "@/lib/errorMessage";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { createImportedGeneration } from "@/lib/generations/service";
import { localVoxelWorldPartResponse, persistLocalVoxelWorld } from "@/lib/voxel/localWorldServer";
import { requireMineBenchAdmin } from "@/lib/gallery/service";
import type { VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().min(1),
  gridSize: z.custom<GridSize>(isGridSize),
  palette: z.union([z.literal("simple"), z.literal("advanced")]),
  seed: z.number().int().optional(),
});

const MAX_CODE_CHARS = 600_000;
const MAX_LOCAL_HEAVY_POSTS = 2;
const LOCAL_HEAVY_RETRY_AFTER_SECONDS = 10;
const localVoxelWorldProcessingGate = createCustomBuildProcessingGate();
let localHeavyPostCount = 0;

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

function disabledResponse(req: Request): Response | null {
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
  return null;
}

function localHeavyBacklogResponse() {
  return NextResponse.json(
    { error: "Too many render requests. Wait a moment and try again." },
    { status: 429, headers: { "Retry-After": String(LOCAL_HEAVY_RETRY_AFTER_SECONDS) } },
  );
}

function acquireLocalHeavyPost(): (() => void) | null {
  if (localHeavyPostCount >= MAX_LOCAL_HEAVY_POSTS) return null;
  localHeavyPostCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    localHeavyPostCount -= 1;
  };
}

async function buildResponse(
  build: VoxelBuild,
  opts: {
    gridSize: GridSize;
    palette: "simple" | "advanced";
    signal?: AbortSignal;
  },
) {
  const palette = getPalette(opts.palette);
  if (opts.gridSize > 512) {
    return NextResponse.json(await persistLocalVoxelWorld({
      sourceBuild: build,
      gridSize: opts.gridSize,
      palette: opts.palette,
      signal: opts.signal,
    }));
  }

  const validated = validateVoxelBuild(build, {
    gridSize: opts.gridSize,
    palette,
    maxBlocks: maxBlocksForGrid(opts.gridSize),
  });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  return NextResponse.json({
    build: validated.value.build,
    warnings: validated.value.warnings,
    blockCount: validated.value.build.blocks.length,
    bounds: null,
  });
}

export async function GET(req: Request) {
  const disabled = disabledResponse(req);
  if (disabled) return disabled;

  try {
    return await localVoxelWorldPartResponse(req);
  } catch (err) {
    return new Response(getErrorMessage(err, "World part request failed"), { status: 400 });
  }
}

export async function POST(req: Request) {
  const disabled = disabledResponse(req);
  if (disabled) return disabled;

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

  if (body.gridSize > 512 && process.env.VERCEL === "1") {
    const ownerId = await getAuthenticatedUserId(req);
    if (!ownerId) return apiJson({ error: "Sign in to import large builds." }, 401);
    try {
      return apiJson({ generation: await createImportedGeneration(ownerId, body) }, 202);
    } catch (error) {
      return apiServiceError(error);
    }
  }

  if (body.gridSize > 512 && process.env.NODE_ENV === "production") {
    const ownerId = await getAuthenticatedUserId(req);
    if (!ownerId) return apiJson({ error: "Sign in to import large builds." }, 401);
    try {
      await requireMineBenchAdmin(ownerId);
    } catch (error) {
      return apiServiceError(error);
    }
  }

  let releaseProcessing: (() => void) | undefined;
  let releaseAdmission: (() => void) | undefined;
  try {
    if (body.gridSize > 512) {
      releaseAdmission = acquireLocalHeavyPost() ?? undefined;
      if (!releaseAdmission) return localHeavyBacklogResponse();
      releaseProcessing = await localVoxelWorldProcessingGate.acquire(req.signal);
    }
    const run = runVoxelExec({
      code: body.code,
      gridSize: body.gridSize,
      palette: body.palette,
      seed: body.seed,
    });
    return await buildResponse(run.build, {
      gridSize: body.gridSize,
      palette: body.palette,
      signal: req.signal,
    });
  } catch (err) {
    return NextResponse.json(
      { error: getErrorMessage(err, "Tool execution failed") },
      { status: err instanceof DOMException && err.name === "AbortError" ? 499 : 400 },
    );
  } finally {
    releaseProcessing?.();
    releaseAdmission?.();
  }
}
