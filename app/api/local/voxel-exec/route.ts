import { NextResponse } from "next/server";
import { z } from "zod";
import { maxBlocksForGrid, isGridSize, type GridSize } from "@/lib/ai/limits";
import { runVoxelExec } from "@/lib/ai/tools/voxelExec";
import { getPalette } from "@/lib/blocks/palettes";
import { createCustomBuildProcessingGate } from "@/lib/custom-builds/processingGate";
import { getErrorMessage } from "@/lib/errorMessage";
import {
  createVoxelBuildSourceArtifactWriter,
  type BuildSourceArtifactWriter,
  type WrittenBuildArtifact,
} from "@/lib/voxel/canonicalArtifact";
import { parseVoxelBuildStream } from "@/lib/voxel/sourceStream";
import { localVoxelWorldPartResponse, persistLocalVoxelWorld } from "@/lib/voxel/localWorldServer";
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
const RAW_BUILD_CONTENT_TYPE = "application/vnd.minebench.build+json";
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

function contentType(req: Request): string {
  return req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
}

async function cancelRequestBody(body: ReadableStream<Uint8Array> | null) {
  await body?.cancel().catch(() => undefined);
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

function queryOptions(req: Request): { ok: true; gridSize: GridSize; palette: "simple" | "advanced" } | { ok: false; response: Response } {
  const url = new URL(req.url);
  const gridSize = Number(url.searchParams.get("gridSize"));
  const palette = url.searchParams.get("palette");
  if (!isGridSize(gridSize) || (palette !== "simple" && palette !== "advanced")) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid build import options" }, { status: 400 }),
    };
  }
  return { ok: true, gridSize, palette };
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  let completed = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* retainingRequestBodyChunks(
  chunks: AsyncIterable<Uint8Array>,
  sourceWriter: BuildSourceArtifactWriter,
): AsyncIterable<Uint8Array> {
  for await (const chunk of chunks) {
    await sourceWriter.write(chunk);
    yield chunk;
  }
}

async function buildResponse(
  build: VoxelBuild,
  opts: {
    gridSize: GridSize;
    palette: "simple" | "advanced";
    sourceArtifact?: WrittenBuildArtifact;
    signal?: AbortSignal;
  },
) {
  const palette = getPalette(opts.palette);
  if (opts.gridSize > 512) {
    return NextResponse.json(await persistLocalVoxelWorld({
      sourceBuild: build,
      sourceArtifact: opts.sourceArtifact,
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

  if (contentType(req) === RAW_BUILD_CONTENT_TYPE) {
    const opts = queryOptions(req);
    if (!opts.ok) {
      await cancelRequestBody(req.body);
      return opts.response;
    }
    if (opts.gridSize <= 512) {
      await cancelRequestBody(req.body);
      return NextResponse.json({ error: "Raw build uploads are only supported for large grids" }, { status: 400 });
    }
    if (!req.body) {
      return NextResponse.json({ error: "Missing build upload body" }, { status: 400 });
    }
    const releaseAdmission = acquireLocalHeavyPost();
    if (!releaseAdmission) {
      await cancelRequestBody(req.body);
      return localHeavyBacklogResponse();
    }
    let releaseProcessing: (() => void) | undefined;
    let sourceWriter: BuildSourceArtifactWriter | undefined;
    let sourceArtifact: WrittenBuildArtifact | undefined;
    let sourceArtifactHandedOff = false;
    try {
      releaseProcessing = await localVoxelWorldProcessingGate.acquire(req.signal);
      sourceWriter = await createVoxelBuildSourceArtifactWriter();
      const build = await parseVoxelBuildStream(retainingRequestBodyChunks(
        requestBodyChunks(req.body),
        sourceWriter,
      ));
      sourceArtifact = await sourceWriter.close();
      sourceWriter = undefined;
      sourceArtifactHandedOff = true;
      return await buildResponse(build, {
        gridSize: opts.gridSize,
        palette: opts.palette,
        sourceArtifact,
        signal: req.signal,
      });
    } catch (err) {
      await cancelRequestBody(req.body);
      await sourceWriter?.abort();
      if (!sourceArtifactHandedOff) await sourceArtifact?.cleanup();
      return NextResponse.json(
        { error: getErrorMessage(err, "Build import failed") },
        { status: err instanceof DOMException && err.name === "AbortError" ? 499 : 400 },
      );
    } finally {
      releaseProcessing?.();
      releaseAdmission();
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
