export type ExplorerLightCluster = {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  faces: number;
};

export function renderExplorerBloomOverlay(
  renderer: { autoClear: boolean },
  render: () => void,
): void {
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    render();
  } finally {
    renderer.autoClear = autoClear;
  }
}

export function clusterExplorerEmissiveFaces(
  positions: ArrayLike<number>,
  cellSize = 8,
): ExplorerLightCluster[] {
  if (!Number.isFinite(cellSize) || cellSize <= 0) return [];
  const clusters = new Map<string, ExplorerLightCluster>();

  for (let i = 0; i + 11 < positions.length; i += 12) {
    const x = (positions[i] + positions[i + 3] + positions[i + 6] + positions[i + 9]) / 4;
    const y = (positions[i + 1] + positions[i + 4] + positions[i + 7] + positions[i + 10]) / 4;
    const z = (positions[i + 2] + positions[i + 5] + positions[i + 8] + positions[i + 11]) / 4;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const ax = positions[i + 3] - positions[i];
    const ay = positions[i + 4] - positions[i + 1];
    const az = positions[i + 5] - positions[i + 2];
    const bx = positions[i + 6] - positions[i];
    const by = positions[i + 7] - positions[i + 1];
    const bz = positions[i + 8] - positions[i + 2];
    const normalX = ay * bz - az * by;
    const normalY = az * bx - ax * bz;
    const normalZ = ax * by - ay * bx;
    const normalLength = Math.hypot(normalX, normalY, normalZ);
    if (normalLength < 1e-6) continue;
    const nx = Math.round(normalX / normalLength);
    const ny = Math.round(normalY / normalLength);
    const nz = Math.round(normalZ / normalLength);
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)},${nx},${ny},${nz}`;
    const cluster = clusters.get(key);
    if (cluster) {
      cluster.x += x;
      cluster.y += y;
      cluster.z += z;
      cluster.faces += 1;
    } else {
      clusters.set(key, { x, y, z, nx, ny, nz, faces: 1 });
    }
  }

  return Array.from(clusters.values(), (cluster) => ({
    x: cluster.x / cluster.faces,
    y: cluster.y / cluster.faces,
    z: cluster.z / cluster.faces,
    nx: cluster.nx,
    ny: cluster.ny,
    nz: cluster.nz,
    faces: cluster.faces,
  }));
}

export function selectNearestExplorerLightClusters(
  clusters: readonly ExplorerLightCluster[],
  position: { x: number; y: number; z: number },
  limit: number,
  maxDistance: number,
): ExplorerLightCluster[] {
  const count = Math.max(0, Math.floor(limit));
  if (count === 0 || !Number.isFinite(maxDistance) || maxDistance <= 0) return [];
  const maxDistanceSquared = maxDistance * maxDistance;
  const nearest: Array<{ cluster: ExplorerLightCluster; distanceSquared: number }> = [];

  for (const cluster of clusters) {
    const distanceSquared =
      (cluster.x - position.x) ** 2 +
      (cluster.y - position.y) ** 2 +
      (cluster.z - position.z) ** 2;
    if (distanceSquared > maxDistanceSquared) continue;
    const index = nearest.findIndex((candidate) => distanceSquared < candidate.distanceSquared);
    if (index < 0) {
      if (nearest.length < count) nearest.push({ cluster, distanceSquared });
    } else {
      nearest.splice(index, 0, { cluster, distanceSquared });
      if (nearest.length > count) nearest.pop();
    }
  }

  return nearest.map(({ cluster }) => cluster);
}
