import { getVoxelExportMaterial } from "@/lib/voxel/export/materials";
import type { VoxelBuild } from "@/lib/voxel/types";

const WIDTH = 640;
const HEIGHT = 400;
const MAX_PREVIEW_BLOCKS = 700;

function colorForBlock(type: string): string {
  const [red, green, blue] = getVoxelExportMaterial(type).baseColorFactor;
  return `#${[red, green, blue]
    .map((value) => Math.round(value * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function buildGalleryPreviewSvg(build: VoxelBuild): string {
  const ordered = [...build.blocks].sort(
    (a, b) => a.x + a.z - (b.x + b.z) || a.y - b.y || a.x - b.x || a.z - b.z,
  );
  const stride = Math.max(1, Math.ceil(ordered.length / MAX_PREVIEW_BLOCKS));
  const points = ordered.filter((_, index) => index % stride === 0).map((block) => ({
    x: (block.x - block.z) * 0.866,
    y: (block.x + block.z) * 0.5 - block.y,
    type: block.type,
  }));

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const scale = Math.min(18, 560 / Math.max(1, maxX - minX), 320 / Math.max(1, maxY - minY));
  const size = Math.max(2.5, Math.min(10, scale * 0.72));
  const offsetX = (WIDTH - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = (HEIGHT - (maxY - minY) * scale) / 2 - minY * scale;
  const paths = points.map((point) => {
    const x = point.x * scale + offsetX;
    const y = point.y * scale + offsetY;
    return `<path d="M${x.toFixed(1)} ${(y - size / 2).toFixed(1)}L${(x + size).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + size / 2).toFixed(1)}L${(x - size).toFixed(1)} ${y.toFixed(1)}Z" fill="${colorForBlock(point.type)}"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true"><g opacity="0.96">${paths.join("")}</g></svg>`;
}
