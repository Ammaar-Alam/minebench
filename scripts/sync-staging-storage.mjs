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
// Objects are copied whole through memory, and the largest builds run to tens
// of megabytes, so a copy can lose its socket under load. A dropped copy used
// to leave staging quietly divergent from production, which defeats the point
// of a staging copy, so transient failures are retried before being reported.
const COPY_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;

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

// A dropped socket, a 429, or a 5xx is worth another attempt; a 404 or a
// permission error is not, and retrying it only slows the run down.
function isRetryable(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/\((4[0-9]{2})\)/.test(message) && !/\((408|429)\)/.test(message)) return false;
  return true;
}

async function copyObjectWithRetry(source, target, objectPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    try {
      return await copyObject(source, target, objectPath);
    } catch (err) {
      lastError = err;
      if (attempt === COPY_ATTEMPTS || !isRetryable(err)) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
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
  //
  // Objects stored with Content-Encoding gzip never compare equal. fetch
  // decompresses them, so the copy has to recompress before upload, and Node's
  // gzip does not reproduce the bytes the original encoder wrote. Their content
  // is identical once decompressed, but their etags are not, so they are
  // recopied on every run. That is wasted transfer rather than divergence, and
  // it is why a converged bucket still reports a small number pending.
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
  const alreadyPresent = pending.filter((objectPath) => targetObjects.has(objectPath)).length;
  if (alreadyPresent > 0) {
    console.log(
      `- ${alreadyPresent} of those already exist and are being recopied because their ` +
        "content could not be proven equal; gzip-stored objects always land here",
    );
  }

  let copied = 0;
  let copiedBytes = 0;
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const objectPath = pending[cursor];
      cursor += 1;
      try {
        copiedBytes += await copyObjectWithRetry(source, target, objectPath);
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
  // Every failure is printed: a truncated list reads as a short tail of noise
  // while leaving staging short of production with no record of what is missing.
  for (const failure of failures) {
    console.error(`- FAIL ${failure.objectPath}: ${failure.error}`);
  }
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} object(s) did not copy, so staging is not a faithful copy of ` +
        "production. Re-run to retry them; the copy is idempotent.",
    );
    process.exitCode = 1;
  }
}

await main();
