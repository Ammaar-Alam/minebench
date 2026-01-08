import type { ModelKey } from "@/lib/ai/modelCatalog";
import type { VoxelBuild } from "@/lib/voxel/types";

export type PaletteMode = "simple" | "advanced";

export type GenerateRequest = {
  prompt: string;
  gridSize: 32 | 64 | 128;
  palette: PaletteMode;
  modelKeys: ModelKey[];
};

export type GenerateEvent =
  | { type: "hello"; ts: number; pad?: string }
  | { type: "ping"; ts: number }
  | { type: "start"; modelKey: ModelKey }
  | { type: "retry"; modelKey: ModelKey; attempt: number; reason?: string }
  | { type: "result"; modelKey: ModelKey; voxelBuild: VoxelBuild; metrics: { blockCount: number; warnings: string[]; generationTimeMs: number } }
  | { type: "error"; modelKey: ModelKey; message: string };
