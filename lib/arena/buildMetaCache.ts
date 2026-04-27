import { prisma } from "@/lib/prisma";

// Lightweight build metadata. Immutable per (buildId, voxelSha256), so cold-warm
// hits do not need a Postgres roundtrip every request. Heavy fields (voxelData,
// storage pointers, arenaSnapshot* json) are intentionally excluded so this
// cache stays tiny in memory under high cardinality.
export type ArenaBuildMetaRow = {
  id: string;
  gridSize: number;
  palette: string;
  blockCount: number;
  voxelByteSize: number | null;
  voxelCompressedByteSize: number | null;
  voxelSha256: string | null;
  arenaBuildHints: unknown | null;
};

export type ArenaBuildSnapshotFields = {
  arenaSnapshotPreview: unknown | null;
  arenaSnapshotPreviewChecksum: string | null;
  arenaSnapshotFull: unknown | null;
  arenaSnapshotFullChecksum: string | null;
};

type CacheEntry = {
  expiresAt: number;
  row: ArenaBuildMetaRow | null;
};

const TTL_MS = 60_000;
const MAX_ENTRIES = 1024;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ArenaBuildMetaRow | null>>();
// per-key generation token. invalidateArenaBuildMeta bumps it so any in-flight
// fetch that started before the invalidation will refuse to write its (now
// stale) row back into the cache.
const generations = new Map<string, number>();

function getGeneration(buildId: string): number {
  return generations.get(buildId) ?? 0;
}

function bumpGeneration(buildId: string) {
  generations.set(buildId, getGeneration(buildId) + 1);
}

function pruneExpired(now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    // js Map iterates in insertion order; touchOnHit re-inserts so the oldest
    // key here is genuinely the least-recently-used.
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function touchOnHit(buildId: string, entry: CacheEntry) {
  // re-insert so the most recent hit is at the end of the iteration order
  cache.delete(buildId);
  cache.set(buildId, entry);
}

export async function getArenaBuildMeta(
  buildId: string,
): Promise<ArenaBuildMetaRow | null> {
  const now = Date.now();
  const cached = cache.get(buildId);
  if (cached && cached.expiresAt > now) {
    touchOnHit(buildId, cached);
    return cached.row;
  }

  const existing = inflight.get(buildId);
  if (existing) return existing;

  const startGen = getGeneration(buildId);
  const promise = (async () => {
    const row = await prisma.build.findUnique({
      where: { id: buildId },
      select: {
        id: true,
        gridSize: true,
        palette: true,
        blockCount: true,
        voxelByteSize: true,
        voxelCompressedByteSize: true,
        voxelSha256: true,
        arenaBuildHints: true,
      },
    });
    // skip the cache write if an invalidation landed while we were fetching;
    // the row may already reflect an out-of-date checksum write.
    if (getGeneration(buildId) === startGen) {
      cache.set(buildId, { expiresAt: Date.now() + TTL_MS, row });
      pruneExpired(Date.now());
    }
    return row;
  })();

  inflight.set(buildId, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(buildId) === promise) {
      inflight.delete(buildId);
    }
  }
}

// Snapshot json fields are large and only needed when the artifact redirect
// path missed and the response cache also missed, so they live outside the
// metadata cache. Subsequent identical requests are served by the
// jsonResponseCache in the build route, which has its own byte-weight cap.
export async function getArenaBuildSnapshotFields(
  buildId: string,
): Promise<ArenaBuildSnapshotFields | null> {
  return prisma.build.findUnique({
    where: { id: buildId },
    select: {
      arenaSnapshotPreview: true,
      arenaSnapshotPreviewChecksum: true,
      arenaSnapshotFull: true,
      arenaSnapshotFullChecksum: true,
    },
  });
}

export function invalidateArenaBuildMeta(buildId: string) {
  cache.delete(buildId);
  inflight.delete(buildId);
  bumpGeneration(buildId);
}
