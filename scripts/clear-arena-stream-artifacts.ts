#!/usr/bin/env npx tsx

import "dotenv/config";
import { getBuildStorageBucketFromEnv, getSupabaseStorageConfig } from "../lib/storage/buildPayload";

type Args = {
  dryRun: boolean;
  yes: boolean;
  prefix: string;
  bucket: string;
};

type StorageItem = {
  name: string;
  id?: string | null;
  metadata?: unknown;
  updated_at?: string | null;
};

const LIST_PAGE_SIZE = 1000;
const DELETE_BATCH_SIZE = 100;

function normalizePrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");

  const prefixIndex = args.indexOf("--prefix");
  const prefixRaw =
    prefixIndex >= 0
      ? args[prefixIndex + 1]
      : process.env.ARENA_STREAM_ARTIFACT_PREFIX ?? "arena-stream/v1";
  const prefix = normalizePrefix(prefixRaw ?? "arena-stream/v1");

  const bucketIndex = args.indexOf("--bucket");
  const bucketRaw =
    bucketIndex >= 0
      ? args[bucketIndex + 1]
      : process.env.ARENA_STREAM_ARTIFACT_BUCKET ?? getBuildStorageBucketFromEnv();
  const bucket = (bucketRaw ?? "").trim();
  if (!bucket) throw new Error("Missing artifact bucket. Set --bucket or ARENA_STREAM_ARTIFACT_BUCKET.");

  return {
    dryRun,
    yes,
    prefix,
    bucket,
  };
}

async function listStorageItems(
  config: ReturnType<typeof getSupabaseStorageConfig>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const paths: string[] = [];
  const queue: string[] = [prefix];

  while (queue.length > 0) {
    const currentPrefix = queue.shift() ?? "";
    let offset = 0;
    while (true) {
      const resp = await fetch(
        `${config.url}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.serviceRoleKey}`,
            apikey: config.serviceRoleKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prefix: currentPrefix,
            limit: LIST_PAGE_SIZE,
            offset,
            sortBy: { column: "name", order: "asc" },
          }),
        },
      );

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`List failed (${resp.status}): ${text || "empty response"}`);
      }

      const items = (await resp.json()) as StorageItem[];
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        const name = item?.name?.trim();
        if (!name) continue;
        const childPath = currentPrefix ? `${currentPrefix}/${name}` : name;
        // Folder-like entries may not include id/metadata.
        const looksLikeFile =
          Boolean(item.id) || Boolean(item.updated_at) || item.metadata != null || name.includes(".");
        if (looksLikeFile) {
          paths.push(childPath);
        } else {
          queue.push(childPath);
        }
      }

      offset += items.length;
      if (items.length < LIST_PAGE_SIZE) break;
    }
  }

  return paths;
}

async function deleteStorageItems(
  config: ReturnType<typeof getSupabaseStorageConfig>,
  bucket: string,
  paths: string[],
): Promise<void> {
  for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
    const batch = paths.slice(i, i + DELETE_BATCH_SIZE);
    const resp = await fetch(`${config.url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: batch }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Delete failed (${resp.status}): ${text || "empty response"}`);
    }

    console.log(
      `- deleted ${Math.min(i + DELETE_BATCH_SIZE, paths.length)}/${paths.length} artifact objects`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = getSupabaseStorageConfig();

  console.log("Clearing arena stream artifacts");
  console.log(`- bucket: ${args.bucket}`);
  console.log(`- prefix: ${args.prefix}`);
  console.log(`- dry run: ${args.dryRun ? "yes" : "no"}`);

  const paths = await listStorageItems(config, args.bucket, args.prefix);
  if (paths.length === 0) {
    console.log("No artifact objects found.");
    return;
  }

  console.log(`Found ${paths.length.toLocaleString()} artifact objects.`);
  const preview = paths.slice(0, 10);
  for (const path of preview) {
    console.log(`- ${path}`);
  }
  if (paths.length > preview.length) {
    console.log(`- ... (${paths.length - preview.length} more)`);
  }

  if (args.dryRun) return;
  if (!args.yes) {
    throw new Error("Refusing destructive delete without --yes. Re-run with --yes.");
  }

  await deleteStorageItems(config, args.bucket, paths);
  console.log(`Done. deleted=${paths.length}`);
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
