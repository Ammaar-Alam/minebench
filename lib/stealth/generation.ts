import { Prisma } from "@prisma/client";
import {
  maybePrecomputeArenaArtifactsForBuild,
  maybePrecomputeArenaArtifactsForPreparedBuild,
} from "@/lib/arena/artifactMaintenance";
import { deleteArenaBuildArtifacts } from "@/lib/arena/artifactOwnership";
import { prepareArenaBuildFromBuild } from "@/lib/arena/buildArtifacts";
import { isLoopbackDatabaseUrl } from "@/lib/db/identity";
import { prisma } from "@/lib/prisma";
import {
  deleteSupabaseStorageObjects,
  getBuildStorageBucketFromEnv,
  getSupabaseStorageConfig,
  uploadSupabaseStorageFile,
} from "@/lib/storage/buildPayload";
import { writeCanonicalBuildArtifact } from "@/lib/voxel/canonicalArtifact";
import type { VoxelBuild } from "@/lib/voxel/types";

const GRID_SIZE = 256;
const PALETTE = "simple";
const MODE = "precise";
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

type PreparedPayload = {
  stored: StoredPayload;
  remote: { url: string; key: string; bucket: string; path: string } | null;
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
  const hasUrl = Boolean(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim(),
  );
  const hasKey = Boolean(
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim(),
  );
  if (!hasUrl && !hasKey) return null;
  const { url, serviceRoleKey } = getSupabaseStorageConfig();
  return {
    url,
    key: serviceRoleKey,
    bucket: getBuildStorageBucketFromEnv(),
  };
}

function preparePayload(params: {
  variantId: string;
  promptSlug: string;
  build: VoxelBuild;
  sha256: string;
  target?: { bucket: string; path: string };
}): PreparedPayload {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  if (isLoopbackDatabaseUrl(databaseUrl)) {
    return {
      stored: {
        voxelData: params.build as unknown as Prisma.InputJsonValue,
        voxelStorageBucket: null,
        voxelStoragePath: null,
        voxelStorageEncoding: null,
      },
      remote: null,
    };
  }
  const config = storageConfig();
  if (!config) {
    throw new Error("Remote stealth generation requires Supabase build storage configuration");
  }

  const bucket = params.target?.bucket ?? config.bucket;
  const path =
    params.target?.path ??
    `${getStealthBuildStoragePrefix(params.variantId)}/${params.promptSlug}-${params.sha256}.json.gz`;
  return {
    stored: {
      voxelData: Prisma.DbNull,
      voxelStorageBucket: bucket,
      voxelStoragePath: path,
      voxelStorageEncoding: "gzip",
    },
    remote: { ...config, bucket, path },
  };
}

async function uploadPreparedPayload(
  prepared: PreparedPayload,
  artifact: { filePath: string; storedByteSize: number },
): Promise<void> {
  if (!prepared.remote) return;
  await uploadSupabaseStorageFile({
    bucket: prepared.remote.bucket,
    path: prepared.remote.path,
    filePath: artifact.filePath,
    byteSize: artifact.storedByteSize,
    contentType: "application/gzip",
    encoding: "gzip",
  });
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

function retryPayloadTarget(build: ExistingBuild): { bucket: string; path: string } | undefined {
  const inline = isLoopbackDatabaseUrl(process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "");
  if (inline) {
    if (build.voxelStorageBucket || build.voxelStoragePath || build.voxelStorageEncoding) {
      throw new Error("Existing stealth build storage identity does not match retry payload");
    }
    return undefined;
  }
  if (
    !build.voxelStorageBucket ||
    !build.voxelStoragePath ||
    build.voxelStorageEncoding !== "gzip"
  ) {
    throw new Error("Existing stealth build storage identity does not match retry payload");
  }
  return { bucket: build.voxelStorageBucket, path: build.voxelStoragePath };
}

async function maybePrecomputeRemoteArtifacts(
  build: ExistingBuild,
  fullBuild?: VoxelBuild,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  if (!isLoopbackDatabaseUrl(databaseUrl)) {
    const source = { ...build, privateAccessOnly: true };
    if (fullBuild) {
      await maybePrecomputeArenaArtifactsForPreparedBuild(
        prepareArenaBuildFromBuild(source, fullBuild, {
          payloadEstimatedBytes: build.voxelByteSize,
          checksum: build.voxelSha256,
        }),
        build.voxelByteSize,
      );
    } else {
      await maybePrecomputeArenaArtifactsForBuild(source);
    }
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
  const artifact = await writeCanonicalBuildArtifact(params.build);
  const sha256 = artifact.sourceSha256;
  const blockCount = params.build.blocks.length;
  try {
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
      voxelByteSize: artifact.byteSize,
      voxelCompressedByteSize: artifact.storedByteSize,
      blockCount,
    };
    const existing = await prisma.build.findUnique({
      where: buildKey,
      select: BUILD_SOURCE_SELECT,
    });
    if (existing) {
      validateExistingBuildIdentity(existing, expectedIdentity);
      const prepared = preparePayload({
        variantId: params.variantId,
        promptSlug: params.promptSlug,
        build: params.build,
        sha256,
        target: retryPayloadTarget(existing),
      });
      await uploadPreparedPayload(prepared, artifact);
      await maybePrecomputeRemoteArtifacts(existing, params.build);
      return { id: existing.id, blockCount: existing.blockCount, created: false };
    }

    const payload = preparePayload({
      variantId: params.variantId,
      promptSlug: params.promptSlug,
      build: params.build,
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
          ...payload.stored,
          voxelByteSize: artifact.byteSize,
          voxelCompressedByteSize: artifact.storedByteSize,
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
        const repair = preparePayload({
          variantId: params.variantId,
          promptSlug: params.promptSlug,
          build: params.build,
          sha256,
          target: retryPayloadTarget(raced),
        });
        await uploadPreparedPayload(repair, artifact);
        await maybePrecomputeRemoteArtifacts(raced, params.build);
        return { id: raced.id, blockCount: raced.blockCount, created: false };
      }
      throw error;
    }

    await uploadPreparedPayload(payload, artifact);
    await maybePrecomputeRemoteArtifacts(build, params.build);
    return { id: build.id, blockCount, created: true };
  } finally {
    await artifact.cleanup();
  }
}

export async function deleteUnacceptedStealthBuild(buildId: string): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM "Build" WHERE id = ${buildId} FOR UPDATE
      `);
      if (locked.length === 0) return true;
      const build = await tx.build.findUnique({
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
        ? await tx.build.findMany({
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
      const deleted = await tx.build.deleteMany({
        where: {
          id: build.id,
          matchupsAsA: { none: {} },
          matchupsAsB: { none: {} },
          stealthGenerationResults: { none: { status: "READY" } },
        },
      });
      return deleted.count === 1;
    },
    { timeout: 60_000 },
  );
}

export function isMissingStealthBuildPayload(error: unknown): boolean {
  return error instanceof Error && /Storage download failed \(404\)/.test(error.message);
}

export async function ensureStealthBuildArtifacts(buildId: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  if (isLoopbackDatabaseUrl(databaseUrl)) return;
  const config = storageConfig();
  if (!config) {
    throw new Error("Remote stealth generation requires Supabase build storage configuration");
  }
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    select: BUILD_SOURCE_SELECT,
  });
  if (!build) throw new Error(`Stealth build not found: ${buildId}`);
  await maybePrecomputeArenaArtifactsForBuild({ ...build, privateAccessOnly: true });
}
