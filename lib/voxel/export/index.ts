import type { BlockDefinition } from "@/lib/blocks/palettes";
import { buildVoxelExportGeometry } from "@/lib/voxel/export/geometry";
import { buildVoxelGlb } from "@/lib/voxel/export/glb";
import { buildSpongeSchematic } from "@/lib/voxel/export/schematic";
import { buildVoxelStl } from "@/lib/voxel/export/stl";
import type { VoxelBuild } from "@/lib/voxel/types";

export type VoxelBuildExportFormat = "glb" | "stl" | "schem";

export type VoxelBuildExportStats = {
  inputBlockCount: number;
  exportedBlockCount: number;
  visibleFaceCount?: number;
  triangleCount?: number;
  materialCount?: number;
  width?: number;
  height?: number;
  length?: number;
  volume?: number;
  paletteSize?: number;
};

export type VoxelBuildExportArtifact = {
  bytes: Uint8Array;
  extension: "glb" | "stl" | "schem";
  mimeType: string;
  stats: VoxelBuildExportStats;
};

export function exportVoxelBuild(
  build: VoxelBuild,
  palette: BlockDefinition[],
  format: VoxelBuildExportFormat,
): VoxelBuildExportArtifact {
  if (format === "schem") {
    const schematic = buildSpongeSchematic(build, palette);
    return {
      bytes: schematic.bytes,
      extension: "schem",
      mimeType: "application/octet-stream",
      stats: {
        inputBlockCount: build.blocks.length,
        exportedBlockCount: schematic.stats.blockCount,
        ...schematic.stats,
      },
    };
  }

  const geometry = buildVoxelExportGeometry(build, palette);
  const bytes = format === "glb" ? buildVoxelGlb(geometry) : buildVoxelStl(geometry);

  return {
    bytes,
    extension: format,
    mimeType: format === "glb" ? "model/gltf-binary" : "model/stl",
    stats: {
      inputBlockCount: geometry.inputBlockCount,
      exportedBlockCount: geometry.exportedBlockCount,
      visibleFaceCount: geometry.visibleFaceCount,
      triangleCount: geometry.triangleCount,
      materialCount: geometry.materialCount,
    },
  };
}

export { buildVoxelExportGeometry } from "@/lib/voxel/export/geometry";
export { buildVoxelGlb } from "@/lib/voxel/export/glb";
export { buildSpongeSchematic } from "@/lib/voxel/export/schematic";
export { buildVoxelStl } from "@/lib/voxel/export/stl";
