import type {
  ArenaBuildLoadHints,
  ArenaBuildStreamEvent,
  ArenaBuildVariant,
} from "@/lib/arena/types";
import type { VoxelBuild, VoxelBlock } from "@/lib/voxel/types";
import { getBuildStorageBucketFromEnv, getSupabaseStorageConfig } from "@/lib/storage/buildPayload";

const ENCODER = new TextEncoder();

const ARENA_STREAM_TARGET_CHUNK_BYTES = readIntEnv(
  "ARENA_STREAM_TARGET_CHUNK_BYTES",
  1_200_000,
  64_000,
  8_000_000,
);
const ARENA_STREAM_MIN_BLOCKS = readIntEnv(
  "ARENA_STREAM_MIN_BLOCKS",
  10_000,
  1_000,
  200_000,
);
const ARENA_STREAM_MAX_CHUNKS = readIntEnv(
  "ARENA_STREAM_MAX_CHUNKS",
  96,
  4,
  256,
);
const ARENA_STREAM_MIN_CHUNK_BLOCKS = readIntEnv(
  "ARENA_STREAM_MIN_CHUNK_BLOCKS",
  2_000,
  250,
  100_000,
);
const ARENA_STREAM_MAX_CHUNK_BLOCKS = readIntEnv(
  "ARENA_STREAM_MAX_CHUNK_BLOCKS",
  95_000,
  5_000,
  1_000_000,
);
const ARENA_STREAM_HELLO_PAD_BYTES = readIntEnv(
  "ARENA_STREAM_HELLO_PAD_BYTES",
  2_048,
  0,
  16_384,
);

const ARENA_STREAM_ARTIFACTS_ENABLED = readBoolEnv("ARENA_STREAM_ARTIFACTS_ENABLED", true);
const ARENA_STREAM_ARTIFACT_PREFIX = normalizePrefix(
  process.env.ARENA_STREAM_ARTIFACT_PREFIX ?? "arena-stream/v1",
);
const ARENA_STREAM_ARTIFACT_BUCKET = (
  process.env.ARENA_STREAM_ARTIFACT_BUCKET ?? getBuildStorageBucketFromEnv()
).trim();

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizePrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeEstimatedBytes(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function estimateBytesFromBlockCount(totalBlocks: number): number {
  // Typical compact JSON footprint for a block entry in this schema.
  return Math.floor(totalBlocks * 34);
}

export type ArenaBuildStreamPlan = {
  totalBlocks: number;
  estimatedBytes: number | null;
  chunkCount: number;
  chunkBlockCount: number;
};

export function planArenaBuildStream(opts: {
  totalBlocks: number;
  hints?: ArenaBuildLoadHints;
}): ArenaBuildStreamPlan {
  const totalBlocks = Math.max(0, Math.floor(opts.totalBlocks));
  if (totalBlocks === 0) {
    return {
      totalBlocks: 0,
      estimatedBytes: 0,
      chunkCount: 0,
      chunkBlockCount: 0,
    };
  }

  const estimatedBytes =
    normalizeEstimatedBytes(opts.hints?.fullEstimatedBytes) ?? estimateBytesFromBlockCount(totalBlocks);

  if (totalBlocks < ARENA_STREAM_MIN_BLOCKS || estimatedBytes <= ARENA_STREAM_TARGET_CHUNK_BYTES) {
    return {
      totalBlocks,
      estimatedBytes,
      chunkCount: 1,
      chunkBlockCount: totalBlocks,
    };
  }

  const chunkCountFromBytes = Math.ceil(estimatedBytes / ARENA_STREAM_TARGET_CHUNK_BYTES);
  const boundedChunkCount = clampInt(chunkCountFromBytes, 1, Math.min(ARENA_STREAM_MAX_CHUNKS, totalBlocks));

  let chunkBlockCount = Math.ceil(totalBlocks / boundedChunkCount);
  chunkBlockCount = clampInt(
    chunkBlockCount,
    ARENA_STREAM_MIN_CHUNK_BLOCKS,
    ARENA_STREAM_MAX_CHUNK_BLOCKS,
  );

  const chunkCount = Math.ceil(totalBlocks / chunkBlockCount);
  return {
    totalBlocks,
    estimatedBytes,
    chunkCount,
    chunkBlockCount,
  };
}

export type ArenaBuildChunk = {
  index: number;
  chunkCount: number;
  receivedBlocks: number;
  totalBlocks: number;
  blocks: VoxelBlock[];
};

export function* iterateArenaBuildChunks(
  build: VoxelBuild,
  chunkBlockCount: number,
): Generator<ArenaBuildChunk> {
  const safeChunkSize = Math.max(1, Math.floor(chunkBlockCount));
  const totalBlocks = build.blocks.length;
  const chunkCount = Math.ceil(totalBlocks / safeChunkSize);

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * safeChunkSize;
    const end = Math.min(totalBlocks, start + safeChunkSize);
    yield {
      index: index + 1,
      chunkCount,
      receivedBlocks: end,
      totalBlocks,
      blocks: build.blocks.slice(start, end),
    };
  }
}

export function encodeArenaBuildStreamEvent(event: ArenaBuildStreamEvent): Uint8Array {
  return ENCODER.encode(`${JSON.stringify(event)}\n`);
}

export const ARENA_BUILD_STREAM_HELLO_PAD =
  ARENA_STREAM_HELLO_PAD_BYTES > 0 ? " ".repeat(ARENA_STREAM_HELLO_PAD_BYTES) : "";

export type ArenaBuildStreamArtifactRef = {
  bucket: string;
  path: string;
};

export function isArenaBuildStreamArtifactEnabled(): boolean {
  return Boolean(ARENA_STREAM_ARTIFACTS_ENABLED && ARENA_STREAM_ARTIFACT_PREFIX && ARENA_STREAM_ARTIFACT_BUCKET);
}

export function getArenaBuildStreamArtifactRef(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
): ArenaBuildStreamArtifactRef | null {
  const normalizedChecksum = checksum?.trim();
  if (!normalizedChecksum) return null;
  if (!isArenaBuildStreamArtifactEnabled()) return null;
  const path = `${ARENA_STREAM_ARTIFACT_PREFIX}/${buildId}/${variant}-${normalizedChecksum}.ndjson`;
  return {
    bucket: ARENA_STREAM_ARTIFACT_BUCKET,
    path,
  };
}

export type ArenaBuildStreamEventSequenceInput = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  build: VoxelBuild;
  buildLoadHints?: ArenaBuildLoadHints;
  source: "live" | "artifact";
  serverValidated: boolean;
  includePad?: boolean;
  durationMs?: number;
};

export function* iterateArenaBuildStreamEvents(
  input: ArenaBuildStreamEventSequenceInput,
): Generator<ArenaBuildStreamEvent> {
  const plan = planArenaBuildStream({
    totalBlocks: input.build.blocks.length,
    hints: input.buildLoadHints,
  });

  yield {
    type: "hello",
    buildId: input.buildId,
    variant: input.variant,
    checksum: input.checksum,
    serverValidated: input.serverValidated,
    buildLoadHints: input.buildLoadHints,
    totalBlocks: plan.totalBlocks,
    chunkCount: plan.chunkCount,
    chunkBlockCount: plan.chunkBlockCount,
    estimatedBytes: plan.estimatedBytes,
    source: input.source,
    pad: input.includePad ? ARENA_BUILD_STREAM_HELLO_PAD : undefined,
  };

  for (const chunk of iterateArenaBuildChunks(input.build, plan.chunkBlockCount || 1)) {
    yield {
      type: "chunk",
      ...chunk,
    };
  }

  yield {
    type: "complete",
    totalBlocks: plan.totalBlocks,
    durationMs: Math.max(0, Math.floor(input.durationMs ?? 0)),
  };
}

export async function fetchArenaBuildStreamArtifact(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  opts?: { signal?: AbortSignal },
): Promise<Response | null> {
  const ref = getArenaBuildStreamArtifactRef(buildId, variant, checksum);
  if (!ref) return null;

  let config: ReturnType<typeof getSupabaseStorageConfig>;
  try {
    config = getSupabaseStorageConfig();
  } catch {
    return null;
  }

  const encodedPath = encodeStoragePath(ref.path);
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(ref.bucket)}/${encodedPath}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
    },
    cache: "no-store",
    signal: opts?.signal,
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const normalized = text.toLowerCase();
    const objectMissing =
      resp.status === 400 &&
      (normalized.includes("not_found") ||
        normalized.includes("object not found") ||
        normalized.includes("\"error\":\"not_found\""));
    if (objectMissing) return null;
    throw new Error(`Stream artifact fetch failed (${resp.status}): ${text || "empty response"}`);
  }
  return resp;
}

export async function uploadArenaBuildStreamArtifact(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  body: Uint8Array,
): Promise<ArenaBuildStreamArtifactRef | null> {
  const ref = getArenaBuildStreamArtifactRef(buildId, variant, checksum);
  if (!ref) return null;

  const config = getSupabaseStorageConfig();
  const encodedPath = encodeStoragePath(ref.path);
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(ref.bucket)}/${encodedPath}`;
  const payload = Buffer.from(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "x-upsert": "true",
      "Content-Type": "application/x-ndjson",
    },
    body: payload,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Stream artifact upload failed (${resp.status}): ${text || "empty response"}`);
  }
  return ref;
}
