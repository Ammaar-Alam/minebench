import { getVoxelExportMaterial } from "@/lib/voxel/export/materials";
import type { VoxelBuild } from "@/lib/voxel/types";

const WIDTH = 640;
const HEIGHT = 400;
const MAX_PREVIEW_BLOCKS = 900;

function colorForBlock(type: string, shade = 0): string {
  const [red, green, blue] = getVoxelExportMaterial(type).baseColorFactor;
  return `#${[red, green, blue]
    .map((value) => {
      const adjusted = shade < 0 ? value * (1 + shade) : value + (1 - value) * shade;
      return Math.round(adjusted * 255).toString(16).padStart(2, "0");
    })
    .join("")}`;
}

function framedRange(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const trim = sorted.length >= 100 ? Math.floor(sorted.length * 0.03) : 0;
  return [sorted[trim] ?? 0, sorted.at(-(trim + 1)) ?? 1];
}

export function buildGalleryPreviewSvg(build: VoxelBuild): string {
  const ordered = [...build.blocks].sort(
    (a, b) => a.x + a.z - (b.x + b.z) || a.y - b.y || a.x - b.x || a.z - b.z,
  );
  const count = Math.min(ordered.length, MAX_PREVIEW_BLOCKS);
  const stride = ordered.length / Math.max(1, count);
  const points = Array.from({ length: count }, (_, index) => ordered[Math.floor(index * stride)]).map((block) => ({
    x: (block.x - block.z) * 0.866,
    y: (block.x + block.z) * 0.5 - block.y,
    type: block.type,
  }));

  const [minX, maxX] = framedRange(points.map((point) => point.x));
  const [minY, maxY] = framedRange(points.map((point) => point.y));
  const scale = Math.min(20, 576 / Math.max(1, maxX - minX), 336 / Math.max(1, maxY - minY));
  const size = Math.max(2.2, Math.min(8, scale * 0.62));
  const topDepth = size * 0.5;
  const sideDepth = size * 0.85;
  const offsetX = WIDTH / 2 - ((minX + maxX) / 2) * scale;
  const offsetY = HEIGHT / 2 - ((minY + maxY) / 2) * scale - sideDepth / 2;
  const paths = points.map((point) => {
    const x = point.x * scale + offsetX;
    const y = point.y * scale + offsetY;
    const top = `M${x.toFixed(1)} ${(y - topDepth).toFixed(1)}L${(x + size).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + topDepth).toFixed(1)}L${(x - size).toFixed(1)} ${y.toFixed(1)}Z`;
    const left = `M${(x - size).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + topDepth).toFixed(1)}L${x.toFixed(1)} ${(y + topDepth + sideDepth).toFixed(1)}L${(x - size).toFixed(1)} ${(y + sideDepth).toFixed(1)}Z`;
    const right = `M${(x + size).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + topDepth).toFixed(1)}L${x.toFixed(1)} ${(y + topDepth + sideDepth).toFixed(1)}L${(x + size).toFixed(1)} ${(y + sideDepth).toFixed(1)}Z`;
    return `<path d="${left}" fill="${colorForBlock(point.type, -0.28)}"/><path d="${right}" fill="${colorForBlock(point.type, -0.12)}"/><path d="${top}" fill="${colorForBlock(point.type, 0.1)}"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true"><g opacity="0.98">${paths.join("")}</g></svg>`;
}
