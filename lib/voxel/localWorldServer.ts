import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import {
  isVoxelWorldRegionPageKey,
  persistVoxelWorldArtifacts,
  type PersistVoxelWorldArtifact,
} from "@/lib/custom-builds/worldArtifacts";
import { sha256Hex } from "@/lib/custom-builds/hash";
import {
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  toOpaqueVoxelWorldManifest,
  toOpaqueVoxelWorldRegionPage,
  type VoxelWorldBounds,
} from "@/lib/voxel/world";
import { writeVoxelBuildSourceArtifact, type WrittenBuildArtifact } from "@/lib/voxel/canonicalArtifact";
import type { VoxelBuild } from "@/lib/voxel/types";

type PaletteName = "simple" | "advanced";

export const LOCAL_VOXEL_WORLD_SOURCE_PART_KEY = "source";

const LOCAL_WORLD_BUCKET = "local-world";
const LOCAL_WORLD_ROOT = path.join(tmpdir(), "minebench-local-voxel-worlds");
const LOCAL_WORLD_TTL_MS = 24 * 60 * 60 * 1000;
const LOCAL_WORLD_LIMIT = 6;
const LOCAL_WORLD_IMMUTABLE_CACHE = "private, max-age=86400, immutable";
const PART_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LocalVoxelWorldResponse = {
  build: {
    version: "1.0";
    blocks: [];
    world: {
      manifest: ReturnType<typeof toOpaqueVoxelWorldManifest>;
      partBaseUrl: string;
    };
  };
  warnings: string[];
  blockCount: number;
  bounds: VoxelWorldBounds | null;
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function assertWorldId(value: string | null): string | null {
  const id = value?.trim();
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

function assertPartKey(value: string | null): string | null {
  const key = value?.trim();
  return key && PART_KEY_RE.test(key) ? key : null;
}

function worldDir(worldId: string): string {
  return path.join(LOCAL_WORLD_ROOT, worldId);
}

function partPath(worldId: string, key: string): string {
  return path.join(worldDir(worldId), key);
}

function localWorldPartBaseUrl(worldId: string): string {
  return `/api/local/voxel-exec?world=${encodeURIComponent(worldId)}`;
}

async function removeWorld(worldId: string): Promise<void> {
  await rm(worldDir(worldId), { recursive: true, force: true });
}

async function cleanupLocalVoxelWorlds(keepWorldId?: string): Promise<void> {
  await mkdir(LOCAL_WORLD_ROOT, { recursive: true });
  const now = Date.now();
  const entries = await readdir(LOCAL_WORLD_ROOT, { withFileTypes: true });
  const worlds = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    try {
      const info = await stat(path.join(LOCAL_WORLD_ROOT, entry.name));
      worlds.push({ id: entry.name, mtimeMs: info.mtimeMs });
    } catch {
      // best-effort cleanup only
    }
  }

  worlds.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const remove = new Set<string>();
  for (const world of worlds) {
    if (world.id !== keepWorldId && now - world.mtimeMs > LOCAL_WORLD_TTL_MS) remove.add(world.id);
  }
  const activeLimit = keepWorldId ? LOCAL_WORLD_LIMIT - 1 : LOCAL_WORLD_LIMIT;
  for (const world of worlds.filter((world) => world.id !== keepWorldId).slice(activeLimit)) {
    remove.add(world.id);
  }
  await Promise.all(Array.from(remove, (id) => removeWorld(id).catch(() => undefined)));
}

async function createWorldDirectory(): Promise<string> {
  await cleanupLocalVoxelWorlds();
  const worldId = randomUUID();
  await mkdir(worldDir(worldId), { recursive: false });
  return worldId;
}

function worldPartKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("World artifact key is required");
  }
  const key = assertPartKey((value as { worldPartKey?: unknown }).worldPartKey as string | null);
  if (!key) throw new Error("Invalid world artifact key");
  return key;
}

export async function persistLocalVoxelWorld(args: {
  sourceBuild: VoxelBuild;
  sourceArtifact?: WrittenBuildArtifact;
  gridSize: number;
  palette: PaletteName;
  signal?: AbortSignal;
}): Promise<LocalVoxelWorldResponse> {
  let worldId: string | null = null;
  let sourceArtifact = args.sourceArtifact;
  let keep = false;
  try {
    worldId = await createWorldDirectory();
    throwIfAborted(args.signal);
    sourceArtifact ??= await writeVoxelBuildSourceArtifact(args.sourceBuild);
    throwIfAborted(args.signal);
    await rename(sourceArtifact.filePath, partPath(worldId, LOCAL_VOXEL_WORLD_SOURCE_PART_KEY));
    throwIfAborted(args.signal);
    const persistArtifact: PersistVoxelWorldArtifact = async (artifact) => {
      throwIfAborted(args.signal);
      if (!artifact.bytes) throw new Error("Local world artifacts must be byte-backed");
      const key = worldPartKey(artifact.exportStats);
      await writeFile(partPath(worldId!, key), artifact.bytes, { flag: "wx" });
      throwIfAborted(args.signal);
      return {
        bucket: LOCAL_WORLD_BUCKET,
        path: key,
        encoding: artifact.encoding ?? "identity",
        storedByteSize: artifact.bytes.byteLength,
        sha256: artifact.sha256 ?? sha256Hex(artifact.bytes),
      };
    };
    const artifacts = await persistVoxelWorldArtifacts({
      customBuildId: worldId,
      publicId: worldId,
      sourceBuildSha256: sourceArtifact.sourceSha256,
      sourceBuild: args.sourceBuild,
      gridSize: args.gridSize,
      palette: args.palette,
      previewTargetBlocks: 3_000,
      persistArtifact,
      throwIfCanceled: () => throwIfAborted(args.signal),
    });
    throwIfAborted(args.signal);
    await cleanupLocalVoxelWorlds(worldId).catch(() => undefined);
    keep = true;
    return {
      build: {
        version: "1.0",
        blocks: [],
        world: {
          manifest: toOpaqueVoxelWorldManifest(artifacts.manifest),
          partBaseUrl: localWorldPartBaseUrl(worldId),
        },
      },
      warnings: artifacts.warnings,
      blockCount: artifacts.manifest.exactBlockCount,
      bounds: artifacts.manifest.bounds,
    };
  } finally {
    await sourceArtifact?.cleanup();
    if (!keep && worldId) await removeWorld(worldId);
  }
}

async function readPartBytes(worldId: string, key: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(partPath(worldId, key)));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readManifest(worldId: string) {
  const bytes = await readPartBytes(worldId, "manifest");
  if (!bytes) return null;
  const parsed = parseVoxelWorldManifest(
    JSON.parse(gunzipSync(bytes).toString("utf8")) as unknown,
    { allowStoredRefs: true },
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function fileStreamResponse(filePath: string, headers: HeadersInit): Response {
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>, {
    headers,
  });
}

function gzipBytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: {
      "Cache-Control": LOCAL_WORLD_IMMUTABLE_CACHE,
      "Content-Type": "application/gzip",
      "Content-Encoding": "gzip",
    },
  });
}

export async function localVoxelWorldPartResponse(request: Request): Promise<Response> {
  await cleanupLocalVoxelWorlds().catch(() => undefined);
  const url = new URL(request.url);
  const worldId = assertWorldId(url.searchParams.get("world"));
  const partKey = assertPartKey(url.searchParams.get("part"));
  if (!worldId || !partKey || partKey === "manifest") {
    return new Response("Artifact not found", { status: 404 });
  }

  const sourcePath = partPath(worldId, LOCAL_VOXEL_WORLD_SOURCE_PART_KEY);
  if (partKey === LOCAL_VOXEL_WORLD_SOURCE_PART_KEY) {
    try {
      await stat(sourcePath);
    } catch {
      return new Response("Artifact not found", { status: 404 });
    }
    return fileStreamResponse(sourcePath, {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/vnd.minebench.build+json",
      "Content-Encoding": "gzip",
    });
  }

  const manifest = await readManifest(worldId);
  if (!manifest) return new Response("Artifact not found", { status: 404 });
  const bytes = await readPartBytes(worldId, partKey);
  if (!bytes) return new Response("Artifact not found", { status: 404 });

  if (isVoxelWorldRegionPageKey(partKey)) {
    const pageRef = manifest.regionPages?.find((page) => page.data.key === partKey);
    if (!pageRef) return new Response("Artifact not found", { status: 404 });
    const parsed = parseVoxelWorldRegionPage(
      JSON.parse(gunzipSync(bytes).toString("utf8")) as unknown,
      {
        allowStoredRefs: true,
        gridSize: manifest.gridSize,
        worldBounds: manifest.bounds,
        pageRef,
      },
    );
    if (!parsed.ok) throw new Error(parsed.error);
    return Response.json(toOpaqueVoxelWorldRegionPage(parsed.value), {
      headers: { "Cache-Control": LOCAL_WORLD_IMMUTABLE_CACHE },
    });
  }

  if (manifest.overview?.data.key === partKey) {
    const overviewSha = "sha256" in manifest.overview.data ? manifest.overview.data.sha256 : null;
    return overviewSha && sha256Hex(bytes) === overviewSha.toLowerCase()
      ? gzipBytesResponse(bytes)
      : new Response("Artifact not found", { status: 404 });
  }

  if (!/^mixed-[a-f0-9]{64}$/i.test(partKey) || sha256Hex(bytes) !== partKey.slice("mixed-".length).toLowerCase()) {
    return new Response("Artifact not found", { status: 404 });
  }
  return gzipBytesResponse(bytes);
}
