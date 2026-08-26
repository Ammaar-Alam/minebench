#!/usr/bin/env -S tsx

import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getCustomBuildStorageBucket, getCustomBuildStoragePrefix } from "@/lib/custom-builds/storage";
import { prisma } from "@/lib/prisma";
import { getSupabaseStorageConfig, LOCAL_BUILD_STORAGE_BUCKET } from "@/lib/storage/config";

type Failure = { generationId: string; artifact?: string; reason: string };

function parseArgs() {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const parsedLimit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : undefined;
  if (limitIndex >= 0 && (!parsedLimit || parsedLimit < 1)) throw new Error("--limit expects a positive integer");
  return { deep: args.includes("--deep"), limit: parsedLimit };
}

function localStorageRoot(): string {
  return path.resolve(process.cwd(), process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR?.trim() || ".custom-build-storage");
}

function localObjectPath(objectPath: string): string {
  const root = localStorageRoot();
  const resolved = path.resolve(root, objectPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Artifact path escapes the local storage root");
  }
  return resolved;
}

async function listLocalObjects(root: string, relative = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return (await Promise.all(entries.map(async (entry) => {
    const child = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? listLocalObjects(root, child) : [child];
  }))).flat();
}

async function listSupabaseObjects(bucket: string, prefix: string): Promise<string[]> {
  const config = getSupabaseStorageConfig();
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const objects: string[] = [];
  const pending = [prefix];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.storage.from(bucket).list(folder, {
        limit: 1000,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Storage listing failed: ${error.message}`);
      for (const entry of data) {
        const objectPath = `${folder}/${entry.name}`;
        if (entry.id) objects.push(objectPath);
        else pending.push(objectPath);
      }
      if (data.length < 1000) break;
    }
  }
  return objects;
}

async function main() {
  const { deep, limit } = parseArgs();
  const bucket = getCustomBuildStorageBucket();
  const prefix = getCustomBuildStoragePrefix();
  const generations = await prisma.customBuild.findMany({
    orderBy: { createdAt: "asc" },
    ...(limit ? { take: limit } : {}),
    select: {
      publicId: true,
      ownerId: true,
      removedAt: true,
      storedByteSize: true,
      deletionPendingAt: true,
      artifacts: {
        select: { bucket: true, path: true, byteSize: true, compressedByteSize: true, storedByteSize: true },
      },
    },
  });
  const failures: Failure[] = [];
  const referencedPaths = new Set<string>();
  let storedBytes = 0;
  let pendingDeletions = 0;

  for (const generation of generations) {
    if (!generation.ownerId && !generation.removedAt) failures.push({ generationId: generation.publicId, reason: "active generation has no owner" });
    if (generation.deletionPendingAt) pendingDeletions += 1;
    const artifactBytes = generation.artifacts.reduce((sum, artifact) => sum + artifact.storedByteSize, 0);
    storedBytes += artifactBytes;
    if (artifactBytes !== generation.storedByteSize) failures.push({ generationId: generation.publicId, reason: `stored-byte total is ${generation.storedByteSize}; artifacts total ${artifactBytes}` });
    for (const artifact of generation.artifacts) {
      if (artifact.bucket !== bucket || !artifact.path.startsWith(`${prefix}/${generation.publicId}/`)) {
        failures.push({ generationId: generation.publicId, artifact: artifact.path, reason: "artifact is outside its owned namespace" });
      }
      const expectedBytes = artifact.compressedByteSize ?? artifact.byteSize;
      if (artifact.storedByteSize !== expectedBytes) failures.push({ generationId: generation.publicId, artifact: artifact.path, reason: `stored-byte value is ${artifact.storedByteSize}; expected ${expectedBytes}` });
      if (referencedPaths.has(artifact.path)) failures.push({ generationId: generation.publicId, artifact: artifact.path, reason: "artifact path is referenced more than once" });
      referencedPaths.add(artifact.path);
      if (deep && bucket === LOCAL_BUILD_STORAGE_BUCKET) {
        try {
          const info = await stat(localObjectPath(artifact.path));
          if (info.size !== artifact.storedByteSize) failures.push({ generationId: generation.publicId, artifact: artifact.path, reason: `object size is ${info.size}; expected ${artifact.storedByteSize}` });
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") failures.push({ generationId: generation.publicId, artifact: artifact.path, reason: "object is missing" });
          else throw error;
        }
      }
    }
  }

  if (deep && !limit) {
    const objects = bucket === LOCAL_BUILD_STORAGE_BUCKET
      ? (await listLocalObjects(localStorageRoot())).filter((objectPath) => objectPath.startsWith(`${prefix}/`))
      : await listSupabaseObjects(bucket, prefix);
    for (const objectPath of objects) {
      if (!referencedPaths.has(objectPath)) failures.push({ generationId: "unowned", artifact: objectPath, reason: "storage object has no database owner" });
    }
    if (bucket !== LOCAL_BUILD_STORAGE_BUCKET) {
      const objectPaths = new Set(objects);
      for (const objectPath of referencedPaths) {
        if (!objectPaths.has(objectPath)) failures.push({ generationId: "unknown", artifact: objectPath, reason: "object is missing" });
      }
    }
  }

  console.log(JSON.stringify({ generations: generations.length, artifacts: referencedPaths.size, storedBytes, pendingDeletions, failures: failures.length, deep }, null, 2));
  for (const failure of failures) console.error(JSON.stringify(failure));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
