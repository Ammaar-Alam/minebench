import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Prisma } from "@prisma/client";
import { maybePrecomputeArenaArtifactsForBuild } from "@/lib/arena/artifactMaintenance";
import type { ArenaBuildSource } from "@/lib/arena/buildArtifacts";
import {
  isLoopbackDatabaseUrl,
  supabaseProjectRefFromApiUrl,
  supabaseProjectRefFromDatabaseUrl,
} from "@/lib/db/identity";
import { prisma } from "@/lib/prisma";
import type { VoxelBuild } from "@/lib/voxel/types";

const GRID_SIZE = 256;
const PALETTE = "simple";
const MODE = "precise";
const DEFAULT_BUCKET = "builds";
const STORAGE_PREFIX = "stealth-builds/v1";

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
  const path = `${STORAGE_PREFIX}/${params.variantId}/${params.promptSlug}.json.gz`;
  const response = await fetch(
    `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodedStoragePath(path)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
        "Content-Type": "application/gzip",
        "x-upsert": "true",
      },
      body: new Uint8Array(
        params.gzip.buffer as ArrayBuffer,
        params.gzip.byteOffset,
        params.gzip.byteLength,
      ),
    },
  );
  if (!response.ok) {
    throw new Error(`Stealth build storage upload failed (${response.status}): ${await response.text()}`);
  }
  return {
    voxelData: Prisma.DbNull,
    voxelStorageBucket: config.bucket,
    voxelStoragePath: path,
    voxelStorageEncoding: "gzip",
  };
}

export async function persistStealthBuild(params: {
  variantId: string;
  modelId: string;
  promptSlug: string;
  promptText: string;
  build: VoxelBuild;
  generationTimeMs: number;
}): Promise<{ id: string; blockCount: number }> {
  const json = Buffer.from(JSON.stringify(params.build), "utf8");
  const gzip = gzipSync(json);
  const sha256 = createHash("sha256").update(json).digest("hex");
  const blockCount = params.build.blocks.length;
  const payload = await storePayload({
    variantId: params.variantId,
    promptSlug: params.promptSlug,
    build: params.build,
    gzip,
  });
  const prompt = await prisma.prompt.upsert({
    where: { text: params.promptText },
    create: { text: params.promptText, active: true },
    update: { active: true },
  });
  const build = await prisma.build.upsert({
    where: {
      promptId_modelId_gridSize_palette_mode: {
        promptId: prompt.id,
        modelId: params.modelId,
        gridSize: GRID_SIZE,
        palette: PALETTE,
        mode: MODE,
      },
    },
    create: {
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
    update: {
      ...payload,
      voxelByteSize: json.byteLength,
      voxelCompressedByteSize: gzip.byteLength,
      voxelSha256: sha256,
      arenaBuildHints: Prisma.DbNull,
      blockCount,
      generationTimeMs: params.generationTimeMs,
    },
  });
  const source: ArenaBuildSource = {
    id: build.id,
    gridSize: build.gridSize,
    palette: build.palette,
    blockCount: build.blockCount,
    voxelByteSize: build.voxelByteSize,
    voxelCompressedByteSize: build.voxelCompressedByteSize,
    voxelSha256: build.voxelSha256,
    voxelData: build.voxelData,
    voxelStorageBucket: build.voxelStorageBucket,
    voxelStoragePath: build.voxelStoragePath,
    voxelStorageEncoding: build.voxelStorageEncoding,
    arenaBuildHints: build.arenaBuildHints,
  };
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  if (!isLoopbackDatabaseUrl(databaseUrl)) {
    await maybePrecomputeArenaArtifactsForBuild(source);
  }
  return { id: build.id, blockCount };
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
