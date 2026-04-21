import type { ModelKey } from "@/lib/ai/modelCatalog";
import type { VoxelBuild } from "@/lib/voxel/types";

export type PaletteMode = "simple" | "advanced";

export type ProviderApiKeys = {
  openai?: string;
  anthropic?: string;
  gemini?: string;
  moonshot?: string;
  deepseek?: string;
  minimax?: string;
  xai?: string;
  openrouter?: string;
  custom?: string;
};

export type GenerateModelRequest =
  | {
      id: string;
      kind: "catalog";
      modelKey: ModelKey;
    }
  | {
      id: string;
      kind: "custom";
      provider: "custom";
      displayName: string;
      modelId: string;
      baseUrl: string;
    };

export type GenerateRequest = {
  prompt: string;
  gridSize: 64 | 256 | 512;
  palette: PaletteMode;
  modelKeys?: ModelKey[];
  models?: GenerateModelRequest[];
  providerKeys?: ProviderApiKeys;
};

export type GenerateEvent =
  | { type: "hello"; ts: number; pad?: string }
  | { type: "ping"; ts: number }
  | { type: "start"; modelKey: string }
  | { type: "retry"; modelKey: string; attempt: number; reason?: string }
  | { type: "delta"; modelKey: string; delta: string }
  | { type: "result"; modelKey: string; voxelBuild: VoxelBuild; metrics: { blockCount: number; warnings: string[]; generationTimeMs: number } }
  | { type: "error"; modelKey: string; message: string; rawText?: string };
