export type VoxelBlock = {
  x: number;
  y: number;
  z: number;
  type: string;
};

export type VoxelPoint = {
  x: number;
  y: number;
  z: number;
};

export type VoxelBox = {
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  type: string;
};

export type VoxelLine = {
  from: VoxelPoint;
  to: VoxelPoint;
  type: string;
};

export type VoxelBuild = {
  version: "1.0";
  boxes?: VoxelBox[];
  lines?: VoxelLine[];
  blocks: VoxelBlock[];
};
