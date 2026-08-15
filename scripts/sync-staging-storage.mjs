import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import dotenv from "dotenv";

// Copies storage objects from the production bucket into the staging bucket
// so a refreshed staging database finds every payload and artifact it
// references. Skips objects that already exist in staging, so re-runs only
// move what is new.
//
// Production config comes from .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_STORAGE_BUCKET); staging from .env.staging.local
// (STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY, and optional
// STAGING_SUPABASE_STORAGE_BUCKET).

const LIST_PAGE_SIZE = 1000;
const CONCURRENCY = 4;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireValue(name, value) {
  if (!value || !String(value).trim()) fail(`Missing ${name}`);
  return String(value).trim();
}

function encodeStoragePath(objectPath) {
  return objectPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function authHeaders(config) {
  return {
    Authorization: `Bearer ${config.serviceRoleKey}`,
    apikey: config.serviceRoleKey,
  };
}

async function listObjects(config, prefix = "") {
  const objects = new Map();
  const queue = [prefix];

  while (queue.length > 0) {
    const currentPrefix = queue.shift() ?? "";
    let offset = 0;
    while (true) {
      const resp = await fetch(
        `${config.url}/storage/v1/object/list/${encodeURIComponent(config.bucket)}`,
        {
          method: "POST",
          headers: { ...authHeaders(config), "Content-Type": "application/json" },
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
        fail(`List failed for ${config.bucket}/${currentPrefix} (${resp.status}): ${text}`);
      }

      const items = await resp.json();
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        const name = item?.name?.trim();
        if (!name) continue;
        const childPath = currentPrefix ? `${currentPrefix}/${name}` : name;
        const looksLikeFile =
          Boolean(item.id) || Boolean(item.updated_at) || item.metadata != null || name.includes(".");
        if (looksLikeFile) {
          objects.set(childPath, item?.metadata ?? null);
        } else {
          queue.push(childPath);
        }
      }

      offset += items.length;
      if (items.length < LIST_PAGE_SIZE) break;
    }
  }

  return objects;
}

function isGzipBytes(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function copyObject(source, target, objectPath) {
  const getResp = await fetch(
    `${source.url}/storage/v1/object/${encodeURIComponent(source.bucket)}/${encodeStoragePath(objectPath)}`,
    { method: "GET", headers: authHeaders(source), cache: "no-store" },
  );
  if (!getResp.ok) {
    const text = await getResp.text().catch(() => "");
    throw new Error(`download failed (${getResp.status}): ${text}`);
  }

  let body = new Uint8Array(await getResp.arrayBuffer());
  const contentType = getResp.headers.get("content-type") ?? "application/octet-stream";
  const cacheControl = getResp.headers.get("cache-control") ?? undefined;
  const sourceEncoding = getResp.headers.get("content-encoding");
  // fetch transparently decompresses gzip bodies; restore the stored encoding
  const wasGzipStored = sourceEncoding === "gzip";
  if (wasGzipStored && !isGzipBytes(body)) {
    body = gzipSync(Buffer.from(body));
  }

  const putResp = await fetch(
    `${target.url}/storage/v1/object/${encodeURIComponent(target.bucket)}/${encodeStoragePath(objectPath)}`,
    {
      method: "POST",
      headers: {
        ...authHeaders(target),
        "x-upsert": "true",
        "Content-Type": contentType,
        ...(cacheControl ? { "cache-control": cacheControl } : {}),
        ...(wasGzipStored ? { "Content-Encoding": "gzip" } : {}),
      },
      body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    },
  );
  if (!putResp.ok) {
    const text = await putResp.text().catch(() => "");
    throw new Error(`upload failed (${putResp.status}): ${text}`);
  }
  return body.byteLength;
}

async function main() {
  const args = process.argv.slice(2);
  const prefixIndex = args.indexOf("--prefix");
  const prefix = prefixIndex >= 0 ? (args[prefixIndex + 1] ?? "") : "";
  const force = args.includes("--force");

  const repoRoot = process.cwd();
  const prodEnv = parseEnvFile(path.join(repoRoot, ".env"));
  const stagingEnv = parseEnvFile(path.join(repoRoot, ".env.staging.local"));

  const source = {
    url: requireValue("SUPABASE_URL in .env", prodEnv.SUPABASE_URL).replace(/\/+$/, ""),
    serviceRoleKey: requireValue(
      "SUPABASE_SERVICE_ROLE_KEY in .env",
      prodEnv.SUPABASE_SERVICE_ROLE_KEY,
    ),
    bucket: (prodEnv.SUPABASE_STORAGE_BUCKET ?? "builds").trim(),
  };
  const target = {
    url: requireValue(
      "STAGING_SUPABASE_URL in .env.staging.local",
      stagingEnv.STAGING_SUPABASE_URL,
    ).replace(/\/+$/, ""),
    serviceRoleKey: requireValue(
      "STAGING_SUPABASE_SERVICE_ROLE_KEY in .env.staging.local",
      stagingEnv.STAGING_SUPABASE_SERVICE_ROLE_KEY,
    ),
    bucket: (stagingEnv.STAGING_SUPABASE_STORAGE_BUCKET?.trim() || source.bucket),
  };

  if (target.url === source.url) {
    fail("Refusing to sync: staging SUPABASE_URL matches production");
  }
  // Restored Build rows keep production's voxelStorageBucket value and the app
  // reads that column directly, so a renamed target bucket would leave every
  // storage-backed build pointing at a bucket staging does not use
  if (target.bucket !== source.bucket) {
    fail(
      `Refusing to sync: staging bucket "${target.bucket}" differs from production "${source.bucket}". ` +
        "Restored database rows reference the production bucket name, so the names must match.",
    );
  }

  console.log(`Source: ${source.url} bucket=${source.bucket} prefix=${prefix || "<all>"}`);
  console.log(`Target: ${target.url} bucket=${target.bucket}`);

  const [sourceObjects, targetObjects] = await Promise.all([
    listObjects(source, prefix),
    force ? Promise.resolve(new Map()) : listObjects(target, prefix),
  ]);
  // An overwritten build reuses its storage path, so path existence alone is
  // not proof the bodies match: the database refresh would bring the new
  // checksum while staging kept serving the old object. Compare content
  // identity (etag when present, else size) and recopy when it differs.
  const contentKey = (meta) => {
    if (!meta || typeof meta !== "object") return null;
    const etag = typeof meta.eTag === "string" ? meta.eTag.replace(/"/g, "") : null;
    const size = typeof meta.size === "number" ? String(meta.size) : null;
    return etag ?? size;
  };
  const pending = Array.from(sourceObjects.entries())
    .filter(([objectPath, meta]) => {
      if (force || !targetObjects.has(objectPath)) return true;
      const sourceKey = contentKey(meta);
      const targetKey = contentKey(targetObjects.get(objectPath));
      // unknown metadata on either side means we cannot prove equality
      if (sourceKey == null || targetKey == null) return true;
      return sourceKey !== targetKey;
    })
    .map(([objectPath]) => objectPath);
  console.log(
    `Objects: ${sourceObjects.size} in source, ${targetObjects.size} in target, ${pending.length} to copy`,
  );

  let copied = 0;
  let copiedBytes = 0;
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const objectPath = pending[cursor];
      cursor += 1;
      try {
        copiedBytes += await copyObject(source, target, objectPath);
        copied += 1;
        if (copied % 50 === 0) {
          console.log(`- copied ${copied}/${pending.length}`);
        }
      } catch (err) {
        failures.push({ objectPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `Done. copied=${copied} bytes=${copiedBytes.toLocaleString()} failed=${failures.length}`,
  );
  for (const failure of failures.slice(0, 20)) {
    console.error(`- FAIL ${failure.objectPath}: ${failure.error}`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

await main();
