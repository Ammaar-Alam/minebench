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

function pruneExpired(now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export async function getArenaBuildMeta(
  buildId: string,
): Promise<ArenaBuildMetaRow | null> {
  const now = Date.now();
  const cached = cache.get(buildId);
  if (cached && cached.expiresAt > now) return cached.row;

  const existing = inflight.get(buildId);
  if (existing) return existing;

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
    cache.set(buildId, { expiresAt: Date.now() + TTL_MS, row });
    pruneExpired(Date.now());
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
}
