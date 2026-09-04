import type { CustomBuildArtifact, Prisma, PrismaClient } from "@prisma/client";
import { gzipSync } from "fflate";
import { sha256Hex } from "@/lib/custom-builds/hash";
import { prisma } from "@/lib/prisma";
import {
  getCustomBuildArtifactDescriptor,
  getCustomBuildArtifactPath,
  getCustomBuildStorageBucket,
  deleteCustomBuildArtifact,
  uploadCustomBuildArtifact,
  uploadCustomBuildArtifactFile,
} from "@/lib/custom-builds/storage";
import type { CustomBuildArtifactKind, CustomBuildStorageEncoding } from "@/lib/custom-builds/types";
import { decodeStoredBuildText } from "@/lib/storage/buildPayload";
import type { VoxelBuild } from "@/lib/voxel/types";

export { writeCanonicalBuildArtifact } from "@/lib/voxel/canonicalArtifact";

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

export { sha256Hex } from "@/lib/custom-builds/hash";

export function jsonBytes(value: unknown): Uint8Array {
  return ENCODER.encode(JSON.stringify(value));
}

export function gzipBytes(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes, { mtime: 0 });
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function decodeAndVerifyCustomBuildArtifactText(args: {
  bytes: Uint8Array;
  encoding?: string | null;
  storedSha256?: string | null;
  sourceSha256?: string | null;
}): string {
  const encoding = args.encoding?.split(",")[0]?.trim().toLowerCase();
  const wantsGzip = encoding === "gzip" || encoding === "x-gzip";
  if (
    args.storedSha256 &&
    (!wantsGzip || hasGzipMagic(args.bytes)) &&
    sha256Hex(args.bytes) !== args.storedSha256
  ) {
    throw new Error("Stored custom build artifact checksum does not match");
  }
  const text = decodeStoredBuildText(args.bytes, args.encoding);
  if (args.sourceSha256 && sha256Hex(text) !== args.sourceSha256) {
    throw new Error("Stored custom build source checksum does not match");
  }
  return text;
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
  bytes?: Uint8Array;
  filePath?: string;
  storedByteSize?: number;
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
  const storedByteSize = args.bytes?.byteLength ?? args.storedByteSize;
  if (storedByteSize == null || storedByteSize < 0) {
    throw new Error("Custom build artifact stored byte size is required");
  }
  const sha256 = args.sha256 ?? (args.bytes ? sha256Hex(args.bytes) : undefined);
  if (!sha256) throw new Error("Custom build artifact sha256 is required for file uploads");
  const path = getCustomBuildArtifactPath({
    publicId: args.publicId,
    kind: args.kind,
    sha256,
    sourceBuildSha256: args.sourceBuildSha256,
  });
  const bucket = getCustomBuildStorageBucket();
  const sourceBuildSha256 = args.sourceBuildSha256 ?? sha256;
  const ownershipKey = {
    customBuildId: args.customBuildId,
    kind: args.kind,
    sourceBuildSha256,
  };
  const existingArtifact = await client.customBuildArtifact.findUnique({
    where: { customBuildId_kind_sourceBuildSha256: ownershipKey },
    select: { bucket: true, path: true },
  });
  const fileName =
    args.kind === "build_json"
      ? `${args.publicId}.json`
      : args.kind === "preview_json"
        ? `${args.publicId}-preview.json.gz`
        : args.kind === "preview_mbv4"
          ? `${args.publicId}-preview.mbv4.gz`
          : args.kind === "viewer_mbv4"
            ? `${args.publicId}.mbv4.gz`
            : args.kind === "viewer_mbf1"
              ? `${args.publicId}.mbf1.gz`
              : args.kind === "preview_svg"
                ? `${args.publicId}-preview.svg`
        : `${args.publicId}.${descriptor.fileExtension}`;

  if (args.bytes) {
    await uploadCustomBuildArtifact({
      bucket,
      path,
      bytes: args.bytes,
      contentType: descriptor.contentType,
      encoding: args.encoding,
    });
  } else if (args.filePath) {
    await uploadCustomBuildArtifactFile({
      bucket,
      path,
      filePath: args.filePath,
      byteSize: storedByteSize,
      contentType: descriptor.contentType,
      encoding: args.encoding,
    });
  } else {
    throw new Error("Custom build artifact bytes or file path are required");
  }

  let artifact: CustomBuildArtifact;
  try {
    artifact = await client.customBuildArtifact.upsert({
      where: { customBuildId_kind_sourceBuildSha256: ownershipKey },
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
        sourceBuildSha256,
        byteSize: args.uncompressedByteSize ?? storedByteSize,
        compressedByteSize: args.encoding === "gzip" ? storedByteSize : undefined,
        storedByteSize,
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
        byteSize: args.uncompressedByteSize ?? storedByteSize,
        compressedByteSize: args.encoding === "gzip" ? storedByteSize : null,
        storedByteSize,
        blockCount: args.blockCount,
        exportStats: args.exportStats,
      },
    });
  } catch (error) {
    if (!existingArtifact || existingArtifact.bucket !== bucket || existingArtifact.path !== path) {
      try {
        await deleteCustomBuildArtifact({ bucket, path });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Custom build artifact ownership and compensation failed");
      }
    }
    throw error;
  }
  const stored = await client.customBuildArtifact.aggregate({
    where: { customBuildId: args.customBuildId },
    _sum: { storedByteSize: true },
  });
  const totalStoredByteSize = stored._sum.storedByteSize ?? 0;
  const generationArtifact = [
    "build_json",
    "preview_mbv4",
    "viewer_mbv4",
    "viewer_mbf1",
    "preview_svg",
  ].includes(args.kind);
  if (generationArtifact) {
    const updated = await client.customBuild.updateMany({
      where: { id: args.customBuildId, removedAt: null, status: "running" },
      data: { storedByteSize: totalStoredByteSize },
    });
    if (updated.count !== 1) {
      await client.customBuild.update({
        where: { id: args.customBuildId },
        data: {
          storedByteSize: totalStoredByteSize,
          objectsDeletedAt: null,
          deletionPendingAt: new Date(),
          deletionError: "Artifact cleanup pending.",
        },
      });
      throw new Error("Custom build is no longer active");
    }
  } else {
    await client.customBuild.update({
      where: { id: args.customBuildId },
      data: { storedByteSize: totalStoredByteSize },
    });
  }
  return artifact;
}
