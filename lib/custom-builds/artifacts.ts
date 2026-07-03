import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Prisma, PrismaClient } from "@prisma/client";
import { gzipSync } from "fflate";
import { prisma } from "@/lib/prisma";
import {
  getCustomBuildArtifactDescriptor,
  getCustomBuildArtifactPath,
  getCustomBuildStorageBucket,
  uploadCustomBuildArtifact,
} from "@/lib/custom-builds/storage";
import type { CustomBuildArtifactKind, CustomBuildStorageEncoding } from "@/lib/custom-builds/types";
import type { VoxelBuild } from "@/lib/voxel/types";

type PrismaTx = Prisma.TransactionClient;

const ENCODER = new TextEncoder();

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function getCustomBuildPreviewTargetBlocks(): number {
  return readIntEnv("CUSTOM_BUILD_PREVIEW_TARGET_BLOCKS", 3_000, 100, 100_000);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function jsonBytes(value: unknown): Uint8Array {
  return ENCODER.encode(JSON.stringify(value));
}

export function gzipBytes(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes, { mtime: 0 });
}

export function decodeGzipText(bytes: Uint8Array): string {
  return gunzipSync(bytes).toString("utf8");
}

export function buildCustomBuildPreview(build: VoxelBuild, targetBlocks = getCustomBuildPreviewTargetBlocks()): VoxelBuild {
  if (build.blocks.length <= targetBlocks) return build;
  const blocks = [];
  const stride = build.blocks.length / targetBlocks;
  for (let i = 0; i < targetBlocks; i += 1) {
    const block = build.blocks[Math.floor(i * stride)];
    if (block) blocks.push(block);
  }
  return { version: "1.0", blocks };
}

export async function uploadAndRecordCustomBuildArtifact(args: {
  customBuildId: string;
  publicId: string;
  kind: CustomBuildArtifactKind;
  bytes: Uint8Array;
  uncompressedByteSize?: number;
  sha256?: string;
  sourceBuildSha256?: string;
  blockCount?: number;
  exportStats?: Prisma.InputJsonValue;
  encoding?: CustomBuildStorageEncoding;
  client?: PrismaClient | PrismaTx;
}) {
  const client = args.client ?? prisma;
  const descriptor = getCustomBuildArtifactDescriptor(args.kind);
  const sha256 = args.sha256 ?? sha256Hex(args.bytes);
  const path = getCustomBuildArtifactPath({
    publicId: args.publicId,
    kind: args.kind,
    sha256,
    sourceBuildSha256: args.sourceBuildSha256,
  });
  const bucket = getCustomBuildStorageBucket();
  const fileName =
    args.kind === "build_json"
      ? `${args.publicId}.json.gz`
      : args.kind === "preview_json"
        ? `${args.publicId}-preview.json.gz`
        : `${args.publicId}.${descriptor.fileExtension}`;

  await uploadCustomBuildArtifact({
    bucket,
    path,
    bytes: args.bytes,
    contentType: descriptor.contentType,
    encoding: args.encoding,
  });

  return client.customBuildArtifact.upsert({
    where: {
      customBuildId_kind_sourceBuildSha256: {
        customBuildId: args.customBuildId,
        kind: args.kind,
        sourceBuildSha256: args.sourceBuildSha256 ?? sha256,
      },
    },
    create: {
      customBuildId: args.customBuildId,
      kind: args.kind,
      format: descriptor.format,
      bucket,
      path,
      encoding: args.encoding ?? "identity",
      contentType: descriptor.contentType,
      fileName,
      sha256,
      sourceBuildSha256: args.sourceBuildSha256 ?? sha256,
      byteSize: args.uncompressedByteSize ?? args.bytes.byteLength,
      compressedByteSize: args.encoding === "gzip" ? args.bytes.byteLength : undefined,
      blockCount: args.blockCount,
      exportStats: args.exportStats,
    },
    update: {
      format: descriptor.format,
      bucket,
      path,
      encoding: args.encoding ?? "identity",
      contentType: descriptor.contentType,
      fileName,
      sha256,
      byteSize: args.uncompressedByteSize ?? args.bytes.byteLength,
      compressedByteSize: args.encoding === "gzip" ? args.bytes.byteLength : null,
      blockCount: args.blockCount,
      exportStats: args.exportStats,
    },
  });
}
