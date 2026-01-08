export type VoxelBlock = {
  x: number;
  y: number;
  z: number;
  type: string;
};

export type VoxelBuild = {
  version: "1.0";
  blocks: VoxelBlock[];
};

