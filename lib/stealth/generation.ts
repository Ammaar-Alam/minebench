import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Prisma } from "@prisma/client";
import { maybePrecomputeArenaArtifactsForBuild } from "@/lib/arena/artifactMaintenance";
import { deleteArenaBuildArtifacts } from "@/lib/arena/artifactOwnership";
import {
  isLoopbackDatabaseUrl,
  supabaseProjectRefFromApiUrl,
  supabaseProjectRefFromDatabaseUrl,
} from "@/lib/db/identity";
import { prisma } from "@/lib/prisma";
import { deleteSupabaseStorageObjects } from "@/lib/storage/buildPayload";
import type { VoxelBuild } from "@/lib/voxel/types";

const GRID_SIZE = 256;
const PALETTE = "simple";
const MODE = "precise";
const DEFAULT_BUCKET = "builds";
const STORAGE_PREFIX = "stealth-builds/v1";

export function getStealthBuildStoragePrefix(variantId: string): string {
  return `${STORAGE_PREFIX}/${variantId}`;
}

type StoredPayload = {
  voxelData: Prisma.InputJsonValue | typeof Prisma.DbNull;
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
  voxelStorageEncoding: string | null;
};

const BUILD_SOURCE_SELECT = {
  id: true,
  gridSize: true,
  palette: true,
  blockCount: true,
  voxelByteSize: true,
  voxelCompressedByteSize: true,
  voxelSha256: true,
  voxelData: true,
  voxelStorageBucket: true,
  voxelStoragePath: true,
  voxelStorageEncoding: true,
  arenaBuildHints: true,
} satisfies Prisma.BuildSelect;

type ExistingBuild = Prisma.BuildGetPayload<{ select: typeof BUILD_SOURCE_SELECT }>;

function storageConfig(): { url: string; key: string; bucket: string } | null {
  const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!url && !key) return null;
  if (!url || !key) {
    throw new Error("Supabase build storage requires both SUPABASE_URL and a server secret key");
  }
  return {
    url,
    key,
    bucket: process.env.SUPABASE_STORAGE_BUCKET?.trim() || DEFAULT_BUCKET,
  };
}

function assertStorageMatchesDatabase(url: string): void {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  const databaseRef = supabaseProjectRefFromDatabaseUrl(databaseUrl);
  const storageRef = supabaseProjectRefFromApiUrl(url);
  if (!databaseRef || !storageRef || databaseRef !== storageRef) {
    throw new Error("Stealth build storage and DATABASE_URL must target the same Supabase project");
  }
}

function encodedStoragePath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function storePayload(params: {
  variantId: string;
  promptSlug: string;
  build: VoxelBuild;
  gzip: Buffer;
  sha256: string;
}): Promise<StoredPayload> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  if (isLoopbackDatabaseUrl(databaseUrl)) {
    return {
      voxelData: params.build as unknown as Prisma.InputJsonValue,
      voxelStorageBucket: null,
      voxelStoragePath: null,
      voxelStorageEncoding: null,
    };
  }
  const config = storageConfig();
  if (!config) {
    throw new Error("Remote stealth generation requires Supabase build storage configuration");
  }

  assertStorageMatchesDatabase(config.url);
  const path =
    `${getStealthBuildStoragePrefix(params.variantId)}/` +
    `${params.promptSlug}-${params.sha256}.json.gz`;
  const response = await fetch(
    `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodedStoragePath(path)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(
        params.gzip.buffer as ArrayBuffer,
        params.gzip.byteOffset,
        params.gzip.byteLength,
      ),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    if (isExistingObjectUploadError(response.status, body)) {
      await assertStoredPayloadMatches(config, path, params.sha256);
    } else {
      throw new Error(`Stealth build storage upload failed (${response.status}): ${body}`);
    }
  }
  return {
    voxelData: Prisma.DbNull,
    voxelStorageBucket: config.bucket,
    voxelStoragePath: path,
    voxelStorageEncoding: "gzip",
  };
}

function isExistingObjectUploadError(status: number, body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    status === 409 ||
    (status === 400 &&
      (normalized.includes("already exists") ||
        normalized.includes("duplicate") ||
        normalized.includes("resource already exists")))
  );
}

async function assertStoredPayloadMatches(
  config: { url: string; key: string; bucket: string },
  path: string,
  expectedSha256: string,
): Promise<void> {
  const response = await fetch(
    `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodedStoragePath(path)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
      },
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(`Stealth build storage identity check failed (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  const sha256 = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error("Existing stealth build object checksum does not match retry payload");
  }
}

function validateExistingBuildIdentity(
  build: ExistingBuild,
  expected: {
    sha256: string;
    voxelByteSize: number;
    voxelCompressedByteSize: number;
    blockCount: number;
  },
): void {
  const mismatches = [
    build.voxelSha256 !== expected.sha256 ? "checksum" : null,
    build.voxelByteSize !== expected.voxelByteSize ? "byte size" : null,
    build.voxelCompressedByteSize !== expected.voxelCompressedByteSize
      ? "compressed byte size"
      : null,
    build.blockCount !== expected.blockCount ? "block count" : null,
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(`Existing stealth build cannot be replaced (${mismatches.join(", ")})`);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

async function maybePrecomputeRemoteArtifacts(build: ExistingBuild): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  if (!isLoopbackDatabaseUrl(databaseUrl)) {
    await maybePrecomputeArenaArtifactsForBuild(build);
  }
}

export async function persistStealthBuild(params: {
  variantId: string;
  modelId: string;
  promptSlug: string;
  promptText: string;
  build: VoxelBuild;
  generationTimeMs: number;
}): Promise<{ id: string; blockCount: number; created: boolean }> {
  const json = Buffer.from(JSON.stringify(params.build), "utf8");
  const gzip = gzipSync(json);
  const sha256 = createHash("sha256").update(json).digest("hex");
  const blockCount = params.build.blocks.length;
  const prompt = await prisma.prompt.upsert({
    where: { text: params.promptText },
    create: { text: params.promptText, active: true },
    update: {},
  });

  const buildKey = {
    promptId_modelId_gridSize_palette_mode: {
      promptId: prompt.id,
      modelId: params.modelId,
      gridSize: GRID_SIZE,
      palette: PALETTE,
      mode: MODE,
    },
  };
  const expectedIdentity = {
    sha256,
    voxelByteSize: json.byteLength,
    voxelCompressedByteSize: gzip.byteLength,
    blockCount,
  };
  const existing = await prisma.build.findUnique({
    where: buildKey,
    select: BUILD_SOURCE_SELECT,
  });
  if (existing) {
    validateExistingBuildIdentity(existing, expectedIdentity);
    await maybePrecomputeRemoteArtifacts(existing);
    return { id: existing.id, blockCount: existing.blockCount, created: false };
  }

  const payload = await storePayload({
    variantId: params.variantId,
    promptSlug: params.promptSlug,
    build: params.build,
    gzip,
    sha256,
  });
  let build: ExistingBuild;
  try {
    build = await prisma.build.create({
      data: {
        promptId: prompt.id,
        modelId: params.modelId,
        gridSize: GRID_SIZE,
        palette: PALETTE,
        mode: MODE,
        ...payload,
        voxelByteSize: json.byteLength,
        voxelCompressedByteSize: gzip.byteLength,
        voxelSha256: sha256,
        blockCount,
        generationTimeMs: params.generationTimeMs,
      },
      select: BUILD_SOURCE_SELECT,
    });
  } catch (error) {
    const raced = await prisma.build.findUnique({
      where: buildKey,
      select: BUILD_SOURCE_SELECT,
    });
    if (raced) {
      validateExistingBuildIdentity(raced, expectedIdentity);
      await maybePrecomputeRemoteArtifacts(raced);
      return { id: raced.id, blockCount: raced.blockCount, created: false };
    }
    if (!isUniqueConstraintError(error)) {
      if (payload.voxelStorageBucket && payload.voxelStoragePath) {
        await deleteSupabaseStorageObjects([
          { bucket: payload.voxelStorageBucket, path: payload.voxelStoragePath },
        ]);
      }
      throw error;
    }
    throw error;
  }

  await maybePrecomputeRemoteArtifacts(build);
  return { id: build.id, blockCount, created: true };
}

export async function deleteUnacceptedStealthBuild(buildId: string): Promise<boolean> {
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    select: {
      id: true,
      voxelSha256: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      _count: {
        select: {
          matchupsAsA: true,
          matchupsAsB: true,
          stealthGenerationResults: { where: { status: "READY" } },
        },
      },
    },
  });
  if (!build) return true;
  if (
    build._count.matchupsAsA > 0 ||
    build._count.matchupsAsB > 0 ||
    build._count.stealthGenerationResults > 0
  ) {
    return false;
  }

  const surviving = build.voxelSha256
    ? await prisma.build.findMany({
        where: { id: { not: build.id }, voxelSha256: build.voxelSha256 },
        select: { voxelSha256: true, voxelStorageBucket: true, voxelStoragePath: true },
      })
    : [];
  const survivingChecksums = new Set(
    surviving.flatMap((entry) => (entry.voxelSha256 ? [entry.voxelSha256] : [])),
  );
  const rawRef =
    build.voxelStorageBucket && build.voxelStoragePath
      ? { bucket: build.voxelStorageBucket, path: build.voxelStoragePath }
      : null;
  if (!isLoopbackDatabaseUrl(process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "")) {
    await deleteArenaBuildArtifacts({
      retiringBuilds: [build],
      survivingChecksums,
      deleteStorage: deleteSupabaseStorageObjects,
    });
    if (
      rawRef &&
      !surviving.some(
        (entry) =>
          entry.voxelStorageBucket === rawRef.bucket && entry.voxelStoragePath === rawRef.path,
      )
    ) {
      await deleteSupabaseStorageObjects([rawRef]);
    }
  }
  const deleted = await prisma.build.deleteMany({
    where: {
      id: build.id,
      matchupsAsA: { none: {} },
      matchupsAsB: { none: {} },
      stealthGenerationResults: { none: { status: "READY" } },
    },
  });
  return deleted.count === 1;
}

export async function ensureStealthBuildArtifacts(buildId: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  if (isLoopbackDatabaseUrl(databaseUrl)) return;
  const config = storageConfig();
  if (!config) {
    throw new Error("Remote stealth generation requires Supabase build storage configuration");
  }
  assertStorageMatchesDatabase(config.url);
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    select: BUILD_SOURCE_SELECT,
  });
  if (!build) throw new Error(`Stealth build not found: ${buildId}`);
  await maybePrecomputeArenaArtifactsForBuild(build);
}
