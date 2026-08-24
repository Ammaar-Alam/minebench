import type { VoxelMeshPayload } from "@/lib/voxel/mesh";

export type ArenaPremeshEntry = {
  matchupId: string;
  promise: Promise<VoxelMeshPayload>;
  controller: AbortController;
  started: boolean;
};

export function claimArenaPremesh(
  entries: Map<string, ArenaPremeshEntry>,
  key: string,
): Promise<VoxelMeshPayload> | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.started) return entry.promise;

  entry.controller.abort();
  entries.delete(key);
  return null;
}
