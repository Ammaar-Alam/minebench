import type { ModelKey } from "@/lib/ai/modelCatalog";
import type {
  CustomRequestBody,
  CustomRequestHeaders,
} from "@/lib/ai/customProviderConfig";
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
  meta?: string;
  zai?: string;
  openrouter?: string;
  custom?: string;
};

export type AcceptedProviderRequestConfiguration = {
  apiMode: string;
  maxOutputTokens: number;
  reasoningMaxTokens?: number;
  thinkingMode: string;
  temperature: number | "default" | "n/a";
  textVerbosity: string;
  responseFormat: string;
};

// The provider-accepted configuration plus routing identity, recorded as
// structured research provenance alongside the prose trace line
export type AcceptedRequestConfigurationRecord = AcceptedProviderRequestConfiguration & {
  providerRoute: "direct" | "openrouter";
  resolvedModelId: string;
};

export type ProviderTelemetryCallbacks = {
  // Fired immediately before each outbound generation request
  onProviderRequest?: () => void;
  // Fired after the provider accepts the settings used for a response
  onAcceptedRequestConfiguration?: (
    configuration: AcceptedProviderRequestConfiguration,
  ) => void;
};

export type GenerateModelRequest =
  | {
      id: string;
      kind: "catalog";
      modelKey: ModelKey;
      headers?: CustomRequestHeaders;
      body?: CustomRequestBody;
    }
  | {
      id: string;
      kind: "custom";
      provider: "custom";
      displayName: string;
      modelId: string;
      baseUrl: string;
      headers?: CustomRequestHeaders;
      body?: CustomRequestBody;
    }
  | {
      id: string;
      kind: "custom";
      provider: "openrouter";
      displayName: string;
      modelId: string;
      headers?: CustomRequestHeaders;
      body?: CustomRequestBody;
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
  | {
      type: "result";
      modelKey: string;
      voxelBuild: VoxelBuild;
      metrics: {
        blockCount: number;
        warnings: string[];
        generationTimeMs: number;
        jsonBytes: number;
      };
    }
  | { type: "error"; modelKey: string; message: string; rawText?: string };
