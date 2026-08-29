"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MODEL_CATALOG, ModelKey } from "@/lib/ai/modelCatalog";
import type { GenerateEvent, GenerateModelRequest, ProviderApiKeys } from "@/lib/ai/types";
import {
  SandboxGifExportButton,
  type SandboxGifExportTarget,
} from "@/components/sandbox/SandboxGifExportButton";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { GenerationPreflightDialog } from "@/components/sandbox/GenerationPreflightDialog";
import { GenerationGalleryButton } from "@/components/gallery/GenerationGalleryButton";
import { readBuildVariantPayload } from "@/lib/arena/clientBuildResponse";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import {
  loadProviderKeysFromStorage,
  saveProviderKeysToStorage,
  selectGenerationProviderKeys,
} from "@/lib/ai/providerKeys";
import { readClientErrorResponse } from "@/lib/clientErrorResponse";
import { downloadSavedGenerationJson } from "@/lib/generations/download";
import type { VoxelBuild } from "@/lib/voxel/types";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";
import { getPalette } from "@/lib/blocks/palettes";
import { enqueueVoxelMetric } from "@/lib/observability/clientMetrics";
import type { SavedGenerationPayload } from "@/lib/generations/service";

type Palette = "simple" | "advanced";
type GridSize = 64 | 256 | 512;
type SelectedModelValue =
  | ModelKey
  | typeof OPENROUTER_MODEL_VALUE
  | typeof CUSTOM_MODEL_VALUE;

type CustomSandboxModel = {
  displayName: string;
  modelId: string;
  baseUrl: string;
};

type SelectedLiveModel =
  | {
      id: string;
      kind: "catalog";
      modelKey: ModelKey;
      displayName: string;
      providerLabel: string;
    }
  | {
      id: string;
      kind: "custom";
      provider: "openrouter" | "custom";
      displayName: string;
      providerLabel: string;
      modelId: string;
      baseUrl?: string;
    };

type ModelResult = {
  modelKey: string;
  status: "idle" | "loading" | "success" | "error";
  voxelBuild: unknown | null;
  error?: string;
  rawText?: string;
  attempt?: number;
  retryReason?: string;
  metrics?: { blockCount: number; warnings: string[]; generationTimeMs: number };
  startedAt?: number;
  customBuildId?: string;
  customBuildPageUrl?: string;
  customBuildStatusUrl?: string;
  customBuildEventsUrl?: string;
  customBuildDownloadUrl?: string;
  customBuildExpandedBytes?: number | null;
  renderGridSize?: GridSize;
  renderPalette?: Palette;
  currentStage?: string;
  submittedPrompt?: string;
  customBuildRetryable?: boolean;
  retryProvider?: keyof ProviderApiKeys;
};

type SavedGenerationCreateResponse = {
  generations: Array<{ id: string; status: "queued" }>;
};

const MAX_LIVE_RAW_TEXT_CHARS = 80_000;
const PREVIEW_MAX_BLOCKS = 30_000;
const PREVIEW_THROTTLE_MS = 450;
const PREVIEW_MAX_BOXES = 600;
const PREVIEW_MAX_LINES = 800;
const DIRECT_PROVIDER_KEYS = [
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["gemini", "Gemini"],
  ["moonshot", "Moonshot"],
  ["deepseek", "DeepSeek"],
  ["minimax", "MiniMax"],
  ["xai", "xAI"],
  ["meta", "Meta Model API"],
  ["zai", "Z.AI"],
] as const satisfies ReadonlyArray<readonly [keyof ProviderApiKeys, string]>;
const OPENROUTER_MODEL_VALUE = "__openrouter__";
const CUSTOM_MODEL_VALUE = "__custom_api__";
const HOSTED_GEMINI_MODEL_KEY = "gemini_3_7_flash";
const HOSTED_GEMINI_NOTICE_KEY = "mb_hosted_gemini_3_7_notice_v1";
const DEFAULT_CUSTOM_MODEL: CustomSandboxModel = {
  displayName: "OpenAI-compatible model",
  modelId: "",
  baseUrl: "",
};
const ENABLED_MODELS = MODEL_CATALOG.filter((model) => model.enabled);
const FALLBACK_MODEL_A: ModelKey = ENABLED_MODELS[0]?.key ?? "openai_gpt_5_4_mini";
const DEFAULT_MODEL_A: ModelKey =
  ENABLED_MODELS.find((model) => model.key === "gemini_3_7_flash")?.key ?? FALLBACK_MODEL_A;
const DEFAULT_MODEL_B: ModelKey =
  ENABLED_MODELS.find(
    (model) => model.key === "openai_gpt_5_4_nano" && model.key !== DEFAULT_MODEL_A
  )?.key ??
  ENABLED_MODELS.find(
    (model) => model.key === "gemini_3_1_flash_lite" && model.key !== DEFAULT_MODEL_A
  )?.key ??
  ENABLED_MODELS.find(
    (model) => model.key === "gemini_3_0_flash" && model.key !== DEFAULT_MODEL_A
  )?.key ??
  ENABLED_MODELS.find((model) => model.key !== DEFAULT_MODEL_A)?.key ??
  DEFAULT_MODEL_A;

function HostedGeminiAnnouncement({
  open,
  onDismiss,
}: {
  open: boolean;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="hosted-gemini-title"
      className="mb-dialog m-auto w-[min(28rem,calc(100%-2rem))] rounded-md border-0 bg-card p-0 text-fg ring-1 ring-border-xl backdrop:bg-bg/60 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      <div className="space-y-6 p-6 sm:p-7">
        <div>
          <p className="mb-eyebrow">Generate</p>
          <h2 id="hosted-gemini-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Gemini 3.7 Flash is free
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Signed-in users can generate without a Gemini or OpenRouter API key for a limited time.
          </p>
        </div>
        <button type="button" className="mb-btn mb-btn-primary h-11 w-full" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </dialog>
  );
}

function safeJsonParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isAdHocModelValue(
  value: string | null | undefined,
): value is typeof OPENROUTER_MODEL_VALUE | typeof CUSTOM_MODEL_VALUE {
  return value === OPENROUTER_MODEL_VALUE || value === CUSTOM_MODEL_VALUE;
}

function findArrayStart(text: string, field: string): number {
  const idx = text.indexOf(`"${field}"`);
  if (idx < 0) return -1;
  const bracket = text.indexOf("[", idx);
  return bracket;
}

function extractObjectSlicesFromArray(text: string, arrayStartIdx: number, maxItems: number): string[] {
  const slices: string[] = [];
  if (arrayStartIdx < 0) return slices;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrayStartIdx; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        slices.push(text.slice(start, i + 1));
        start = -1;
        if (slices.length >= maxItems) return slices;
      }
    }
  }

  return slices;
}

function buildPreviewFromRawText(opts: {
  rawText: string;
  gridSize: GridSize;
  palette: Palette;
}): VoxelBuild | null {
  const blocksIdx = findArrayStart(opts.rawText, "blocks");
  const boxesIdx = findArrayStart(opts.rawText, "boxes");
  const linesIdx = findArrayStart(opts.rawText, "lines");

  const blockSlices =
    blocksIdx >= 0 ? extractObjectSlicesFromArray(opts.rawText, blocksIdx, PREVIEW_MAX_BLOCKS) : [];
  const boxSlices =
    boxesIdx >= 0 ? extractObjectSlicesFromArray(opts.rawText, boxesIdx, PREVIEW_MAX_BOXES) : [];
  const lineSlices =
    linesIdx >= 0 ? extractObjectSlicesFromArray(opts.rawText, linesIdx, PREVIEW_MAX_LINES) : [];

  const blocks: { x: number; y: number; z: number; type: string }[] = [];
  for (const s of blockSlices) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const p = parsed as { x?: unknown; y?: unknown; z?: unknown; type?: unknown };
      const x = typeof p.x === "number" ? Math.trunc(p.x) : null;
      const y = typeof p.y === "number" ? Math.trunc(p.y) : null;
      const z = typeof p.z === "number" ? Math.trunc(p.z) : null;
      const type = typeof p.type === "string" ? p.type : null;
      if (x == null || y == null || z == null || !type) continue;
      blocks.push({ x, y, z, type });
    } catch {
      // ignore
    }
  }

  const boxes: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; type: string }[] = [];
  for (const s of boxSlices) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const p = parsed as {
        x1?: unknown; y1?: unknown; z1?: unknown;
        x2?: unknown; y2?: unknown; z2?: unknown;
        type?: unknown;
      };
      const x1 = typeof p.x1 === "number" ? Math.trunc(p.x1) : null;
      const y1 = typeof p.y1 === "number" ? Math.trunc(p.y1) : null;
      const z1 = typeof p.z1 === "number" ? Math.trunc(p.z1) : null;
      const x2 = typeof p.x2 === "number" ? Math.trunc(p.x2) : null;
      const y2 = typeof p.y2 === "number" ? Math.trunc(p.y2) : null;
      const z2 = typeof p.z2 === "number" ? Math.trunc(p.z2) : null;
      const type = typeof p.type === "string" ? p.type : null;
      if (x1 == null || y1 == null || z1 == null || x2 == null || y2 == null || z2 == null || !type) continue;
      boxes.push({ x1, y1, z1, x2, y2, z2, type });
    } catch {
      // ignore
    }
  }

  const lines: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; type: string }[] = [];
  for (const s of lineSlices) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const p = parsed as { from?: unknown; to?: unknown; type?: unknown };
      const fromObj = p.from && typeof p.from === "object" ? (p.from as { x?: unknown; y?: unknown; z?: unknown }) : null;
      const toObj = p.to && typeof p.to === "object" ? (p.to as { x?: unknown; y?: unknown; z?: unknown }) : null;
      const type = typeof p.type === "string" ? p.type : null;
      const fx = fromObj && typeof fromObj.x === "number" ? Math.trunc(fromObj.x) : null;
      const fy = fromObj && typeof fromObj.y === "number" ? Math.trunc(fromObj.y) : null;
      const fz = fromObj && typeof fromObj.z === "number" ? Math.trunc(fromObj.z) : null;
      const tx = toObj && typeof toObj.x === "number" ? Math.trunc(toObj.x) : null;
      const ty = toObj && typeof toObj.y === "number" ? Math.trunc(toObj.y) : null;
      const tz = toObj && typeof toObj.z === "number" ? Math.trunc(toObj.z) : null;
      if (fx == null || fy == null || fz == null || tx == null || ty == null || tz == null || !type) continue;
      lines.push({ from: { x: fx, y: fy, z: fz }, to: { x: tx, y: ty, z: tz }, type });
    } catch {
      // ignore
    }
  }

  if (blocks.length === 0 && boxes.length === 0 && lines.length === 0) return null;

  const validated = validateVoxelBuild(
    { version: "1.0", blocks, boxes, lines },
    {
      gridSize: opts.gridSize,
      palette: getPalette(opts.palette),
      maxBlocks: PREVIEW_MAX_BLOCKS,
    }
  );
  if (!validated.ok) return null;
  return validated.value.build;
}

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "gemini") return "Google";
  if (provider === "moonshot") return "Moonshot";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "minimax") return "MiniMax";
  if (provider === "custom") return "Custom API";
  if (provider === "xai") return "xAI";
  if (provider === "zai") return "Z.AI";
  if (provider === "qwen") return "Qwen";
  if (provider === "meta") return "Meta";
  return provider;
}

function sanitizeFilePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getRawBuildJsonForExport(args: {
  voxelBuild?: unknown;
  rawJsonText?: string;
}): string | null {
  if (args.voxelBuild != null) {
    try {
      return JSON.stringify(args.voxelBuild, null, 2);
    } catch {
      // ignore and try raw text extraction
    }
  }

  const raw = typeof args.rawJsonText === "string" ? args.rawJsonText.trim() : "";
  if (!raw) return null;
  const extracted = extractBestVoxelBuildJson(raw);
  if (!extracted) return null;
  const parsed = parseVoxelBuildSpec(extracted);
  if (!parsed.ok) return null;

  try {
    return JSON.stringify(parsed.value, null, 2);
  } catch {
    return null;
  }
}

function getResultJsonBytes(result: ModelResult): number | undefined {
  if (
    typeof result.customBuildExpandedBytes === "number" &&
    Number.isFinite(result.customBuildExpandedBytes) &&
    result.customBuildExpandedBytes >= 0
  ) {
    return result.customBuildExpandedBytes;
  }
  const source = result.rawText;
  return source ? new Blob([source]).size : undefined;
}

function customBuildStageLabel(status: SavedGenerationPayload): string {
  if (status.status === "succeeded") return "Ready";
  if (status.status === "failed") return "Failed";
  if (status.status === "canceled") return "Canceled";
  if (status.stage === "retrying") return "Trying again";
  if (status.stage === "generating") return "Generating";
  if (status.stage === "queued") return "Queued";
  return status.stage ?? (status.status === "running" ? "Generating" : "Queued");
}

function customBuildStatusPath(id: string): string {
  return `/api/generations/${encodeURIComponent(id)}`;
}

class CustomBuildStatusReadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "CustomBuildStatusReadError";
  }
}

class CustomBuildViewerReadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "CustomBuildViewerReadError";
  }
}

async function readCustomBuildStatus(statusUrl: string, signal?: AbortSignal): Promise<SavedGenerationPayload> {
  const res = await fetch(statusUrl, { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const obj = safeJsonParseObject(text);
    const message =
      obj &&
      typeof obj.error === "object" &&
      obj.error &&
      "message" in obj.error &&
      typeof (obj.error as { message?: unknown }).message === "string"
        ? (obj.error as { message: string }).message
        : text || "Status unavailable";
    throw new CustomBuildStatusReadError(
      message,
      res.status === 408 || res.status === 429 || res.status >= 500,
    );
  }
  const body = (await res.json()) as { generation: SavedGenerationPayload };
  return body.generation;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function readCustomBuildViewer(
  status: SavedGenerationPayload,
  signal?: AbortSignal,
): Promise<VoxelBuild | null> {
  if (!status.viewerUrl) return null;
  try {
    const res = await fetch(status.viewerUrl, { cache: "no-store", signal, redirect: "follow" });
    if (!res.ok) {
      throw new CustomBuildViewerReadError(
        "Viewer unavailable",
        res.status === 408 || res.status === 429 || res.status >= 500,
      );
    }
    const result = await readBuildVariantPayload(res, {
      fallbackIdentity: { buildId: status.id, variant: "full", checksum: status.sha256 },
    });
    return result.payload.voxelBuild as VoxelBuild;
  } catch (error) {
    if (isAbortError(error) || error instanceof CustomBuildViewerReadError) throw error;
    if (error instanceof TypeError) {
      throw new CustomBuildViewerReadError("Viewer unavailable", true);
    }
    throw error;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function customBuildMetrics(status: SavedGenerationPayload): ModelResult["metrics"] | undefined {
  if (status.status !== "succeeded") return undefined;
  return {
    blockCount: status.blockCount ?? 0,
    warnings: status.warnings,
    generationTimeMs: status.generationTimeMs ?? 0,
  };
}

function customBuildGridSize(value: number, fallback: GridSize): GridSize {
  return value === 64 || value === 256 || value === 512 ? value : fallback;
}

function customBuildPalette(value: string, fallback: Palette): Palette {
  return value === "advanced" ? "advanced" : value === "simple" ? "simple" : fallback;
}

function customBuildRetryProvider(status: SavedGenerationPayload): keyof ProviderApiKeys {
  if (status.model.transport === "openrouter") return "openrouter";
  if (status.model.transport === "custom") return "custom";
  return status.model.provider as keyof ProviderApiKeys;
}

export function SandboxLive({
  initialPrompt,
  signedIn,
  hostedGeminiAvailable,
  hasPublicNickname,
  gallerySuspended,
}: {
  initialPrompt?: string;
  signedIn: boolean;
  hostedGeminiAvailable: boolean;
  hasPublicNickname: boolean;
  gallerySuspended: boolean;
}) {
  const [prompt, setPrompt] = useState(() => initialPrompt ?? "");
  const [gridSize, setGridSize] = useState<GridSize>(256);
  const [palette, setPalette] = useState<Palette>("simple");
  const [providerKeys, setProviderKeys] = useState<ProviderApiKeys>(() => loadProviderKeysFromStorage());
  const [customModel, setCustomModel] = useState<CustomSandboxModel>(DEFAULT_CUSTOM_MODEL);
  const [showKeys, setShowKeys] = useState(false);
  const [modelPair, setModelPair] = useState<{ a: SelectedModelValue; b: SelectedModelValue | null }>({
    a: DEFAULT_MODEL_A,
    b: DEFAULT_MODEL_B !== DEFAULT_MODEL_A ? DEFAULT_MODEL_B : null,
  });
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [results, setResults] = useState<Map<string, ModelResult>>(
    () =>
      new Map(
        MODEL_CATALOG.map((m) => [
          m.key,
          { modelKey: m.key, status: "idle", voxelBuild: null } as ModelResult,
        ])
      )
  );
  const [running, setRunning] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [showGenerationPreflight, setShowGenerationPreflight] = useState(false);
  const [showHostedGeminiAnnouncement, setShowHostedGeminiAnnouncement] = useState(false);
  const savedKeyCount = Object.values(providerKeys).filter((value) => Boolean(value?.trim())).length;
  const canUseHostedGemini = Boolean(
    hostedGeminiAvailable &&
    !providerKeys.gemini?.trim() &&
    !providerKeys.openrouter?.trim(),
  );
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [providerKeysOpen, setProviderKeysOpen] = useState(false);
  const [, forceRender] = useState(0);
  const generateAbortRef = useRef<AbortController | null>(null);
  const customBuildAbortRef = useRef<AbortController | null>(null);
  const durableRunSequenceRef = useRef(0);
  const activeDurableRunRef = useRef<number | null>(null);
  const canceledDurableRunsRef = useRef(new Set<number>());
  const previewCacheRef = useRef(
    new Map<string, { at: number; textLen: number; build: VoxelBuild | null }>()
  );
  const viewerARef = useRef<VoxelViewerHandle | null>(null);
  const viewerBRef = useRef<VoxelViewerHandle | null>(null);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, (typeof ENABLED_MODELS)[number][]>();
    for (const model of ENABLED_MODELS) {
      const key = providerLabel(model.provider);
      const rows = groups.get(key) ?? [];
      rows.push(model);
      groups.set(key, rows);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, models]) => ({ label, models }));
  }, []);
  const canCompare = true;
  const adHocModelValue = isAdHocModelValue(modelPair.a)
    ? modelPair.a
    : compareEnabled && isAdHocModelValue(modelPair.b)
      ? modelPair.b
      : null;
  const usesAdHocModel = adHocModelValue !== null;
  const usesOpenRouterModel = adHocModelValue === OPENROUTER_MODEL_VALUE;
  const usesOpenAiCompatibleModel = adHocModelValue === CUSTOM_MODEL_VALUE;
  const selectedModels = useMemo(() => {
    const picked: SelectedLiveModel[] = [];
    const pushValue = (value: SelectedModelValue | null) => {
      if (!value) return;
      if (isAdHocModelValue(value)) {
        const usesOpenRouter = value === OPENROUTER_MODEL_VALUE;
        picked.push({
          id: usesOpenRouter ? "openrouter" : "custom",
          kind: "custom",
          provider: usesOpenRouter ? "openrouter" : "custom",
          displayName: usesOpenRouter
            ? customModel.modelId.trim() || "OpenRouter model"
            : customModel.displayName.trim() || "OpenAI-compatible model",
          providerLabel: usesOpenRouter ? "OpenRouter" : "OpenAI-compatible",
          modelId: customModel.modelId.trim(),
          ...(usesOpenRouter ? {} : { baseUrl: customModel.baseUrl.trim() }),
        });
        return;
      }
      const model = MODEL_CATALOG.find((entry) => entry.key === value);
      if (!model) return;
      picked.push({
        id: model.key,
        kind: "catalog",
        modelKey: model.key,
        displayName: model.displayName,
        providerLabel: providerLabel(model.provider),
      });
    };
    pushValue(modelPair.a);
    if (compareEnabled && modelPair.b && (!isAdHocModelValue(modelPair.b) || !isAdHocModelValue(modelPair.a))) {
      pushValue(modelPair.b);
    }
    return picked;
  }, [compareEnabled, customModel, modelPair.a, modelPair.b]);
  const inputSignature = useMemo(
    () =>
      [
        prompt,
        gridSize,
        palette,
        selectedModels
          .map((model) =>
            model.kind === "catalog"
              ? model.modelKey
              : `${model.provider}:${model.displayName}:${model.modelId}:${model.baseUrl ?? ""}`,
          )
          .join("|"),
      ].join("\0"),
    [gridSize, palette, prompt, selectedModels],
  );
  const lastGenerateInputRef = useRef<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => forceRender((c) => c + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    saveProviderKeysToStorage(providerKeys);
  }, [providerKeys]);

  useEffect(() => {
    if (!signedIn || !hostedGeminiAvailable) return;
    try {
      if (!window.localStorage.getItem(HOSTED_GEMINI_NOTICE_KEY)) {
        setShowHostedGeminiAnnouncement(true);
      }
    } catch {
      setShowHostedGeminiAnnouncement(true);
    }
  }, [hostedGeminiAvailable, signedIn]);

  function dismissHostedGeminiAnnouncement() {
    try {
      window.localStorage.setItem(HOSTED_GEMINI_NOTICE_KEY, "1");
    } catch {}
    setShowHostedGeminiAnnouncement(false);
  }

  function modelOptionLabel(model: (typeof ENABLED_MODELS)[number]): string {
    return model.key === HOSTED_GEMINI_MODEL_KEY && canUseHostedGemini
      ? `${model.displayName} · Free`
      : model.displayName;
  }

  useEffect(() => {
    if (lastGenerateInputRef.current === inputSignature) return;
    if (signedIn) {
      previewCacheRef.current.clear();
      setRequestError(null);
      return;
    }
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    customBuildAbortRef.current?.abort();
    customBuildAbortRef.current = null;
    previewCacheRef.current.clear();
    setRunning(false);
    setRequestError(null);
    setResults((prev) => {
      const next = new Map(prev);
      for (const model of selectedModels) {
        next.set(model.id, { modelKey: model.id, status: "idle", voxelBuild: null });
      }
      return next;
    });
  }, [inputSignature, selectedModels, signedIn]);

  useEffect(() => {
    if (!compareEnabled) return;
    setModelPair((prev) => {
      if (prev.b && prev.b !== prev.a && !(isAdHocModelValue(prev.a) && isAdHocModelValue(prev.b))) {
        return prev;
      }
      const fallback = ENABLED_MODELS.find((model) => model.key !== prev.a)?.key ?? null;
      const nextB = fallback ?? CUSTOM_MODEL_VALUE;
      if (nextB === prev.b) return prev;
      return { ...prev, b: nextB };
    });
  }, [compareEnabled]);

  function handleModelChange(slot: "a" | "b", value: string) {
    if (slot === "b" && !value) {
      setModelPair((prev) => ({ ...prev, b: null }));
      return;
    }
    const nextValue = value as SelectedModelValue;
    setModelPair((prev) => {
      if (slot === "a") {
        if (nextValue === prev.a) return prev;
        if (
          !compareEnabled ||
          prev.b == null ||
          isAdHocModelValue(nextValue) ||
          isAdHocModelValue(prev.b) ||
          nextValue !== prev.b
        ) {
          return { a: nextValue, b: prev.b };
        }
        const fallback = ENABLED_MODELS.find((model) => model.key !== nextValue)?.key ?? null;
        return { a: nextValue, b: fallback ?? CUSTOM_MODEL_VALUE };
      }
      if (isAdHocModelValue(nextValue) && isAdHocModelValue(prev.a)) {
        return prev;
      }
      if (
        !isAdHocModelValue(nextValue) &&
        !isAdHocModelValue(prev.a) &&
        (nextValue === prev.a || nextValue === prev.b)
      ) {
        return prev;
      }
      return { a: prev.a, b: nextValue };
    });
  }

  function updateCustomModel(patch: Partial<CustomSandboxModel>) {
    setCustomModel((prev) => ({ ...prev, ...patch }));
  }

  function stopGenerate() {
    if (signedIn) {
      const runId = activeDurableRunRef.current;
      if (runId !== null) canceledDurableRunsRef.current.add(runId);
      const ids = selectedModels.flatMap((model) => {
        const result = results.get(model.id);
        return result?.status === "loading" && result.customBuildId ? [result.customBuildId] : [];
      });
      if (ids.length > 0) {
        customBuildAbortRef.current?.abort();
        customBuildAbortRef.current = null;
      }
      void Promise.all(
        ids.map((id) =>
          fetch(`/api/generations/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
        ),
      ).then((responses) => {
        if (responses.some((response) => !response.ok)) throw new Error("cancel_failed");
      }).catch(() => setRequestError("Generation could not be stopped."));
      setRunning(false);
      setResults((prev) => {
        const next = new Map(prev);
        for (const model of selectedModels) {
          const existing = next.get(model.id);
          if (!existing || existing.status !== "loading") continue;
          next.set(model.id, {
            ...existing,
            status: "error",
            voxelBuild: null,
            error: "Generation stopped",
          });
        }
        return next;
      });
      return;
    }
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    customBuildAbortRef.current?.abort();
    customBuildAbortRef.current = null;
    setRunning(false);
    setResults((prev) => {
      const next = new Map(prev);
      for (const model of selectedModels) {
        const existing = next.get(model.id);
        if (!existing || existing.status !== "loading") continue;
        next.set(model.id, {
          ...existing,
          status: "error",
          voxelBuild: null,
          error: "Generation stopped",
        });
      }
      return next;
    });
  }

  function exportModelJson(args: {
    modelName: string;
    modelKey: string;
    promptText: string;
    rawBuildJson?: string;
  }) {
    const modelToken = sanitizeFilePart(args.modelName) || args.modelKey;
    const promptToken = sanitizeFilePart(args.promptText) || "sandbox";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `minebench-build-${modelToken}-${promptToken}-${stamp}.json`;
    const json = typeof args.rawBuildJson === "string" ? args.rawBuildJson.trim() : "";
    if (!json) return;
    triggerDownload(new Blob([json], { type: "application/json" }), fileName);
  }

  function customBuildRequestModel(model: SelectedLiveModel): GenerateModelRequest {
    if (model.kind === "catalog") {
      return {
        id: model.id,
        kind: "catalog" as const,
        modelKey: model.modelKey,
      };
    }
    if (model.provider === "custom") {
      return {
        id: model.id,
        kind: "custom",
        provider: "custom",
        displayName: model.displayName,
        modelId: model.modelId,
        baseUrl: model.baseUrl ?? "",
      };
    }
    return {
      id: model.id,
      kind: "custom",
      provider: "openrouter",
      displayName: model.displayName,
      modelId: model.modelId,
    };
  }

  function applyCustomBuildStatus(args: {
    model: SelectedLiveModel;
    status: SavedGenerationPayload;
    build?: unknown | null;
    pageUrl?: string;
    statusUrl?: string;
    eventsUrl?: string;
  }) {
    setResults((prev) => {
      const next = new Map(prev);
      const existing = next.get(args.model.id);
      if (!existing || (existing?.customBuildId && existing.customBuildId !== args.status.id)) {
        return prev;
      }
      const statusGridSize = customBuildGridSize(args.status.gridSize, existing?.renderGridSize ?? gridSize);
      const statusPalette = customBuildPalette(args.status.palette, existing?.renderPalette ?? palette);
      const base = {
        modelKey: args.model.id,
        customBuildId: args.status.id,
        customBuildPageUrl: args.pageUrl ?? existing?.customBuildPageUrl ?? "/account#builds",
        customBuildStatusUrl: args.statusUrl ?? existing?.customBuildStatusUrl,
        customBuildEventsUrl: args.eventsUrl ?? existing?.customBuildEventsUrl,
        customBuildDownloadUrl: args.status.downloadUrl ?? existing?.customBuildDownloadUrl,
        customBuildExpandedBytes: args.status.expandedBytes,
        renderGridSize: statusGridSize,
        renderPalette: statusPalette,
        startedAt: existing?.startedAt,
        currentStage: customBuildStageLabel(args.status),
        submittedPrompt: existing?.submittedPrompt,
        attempt: args.status.attempt ?? undefined,
        retryReason: args.status.retryReason ?? undefined,
        customBuildRetryable: args.status.error?.retryable === true,
        retryProvider: customBuildRetryProvider(args.status),
      };

      if (args.status.status === "failed" || args.status.status === "canceled") {
        next.set(args.model.id, {
          ...base,
          status: "error",
          voxelBuild: null,
          error: args.status.error?.message ?? customBuildStageLabel(args.status),
        });
        return next;
      }

      if (args.status.status === "succeeded") {
        next.set(args.model.id, {
          ...base,
          status: "success",
          voxelBuild: args.build ?? existing?.voxelBuild ?? null,
          metrics: customBuildMetrics(args.status),
        });
        return next;
      }

      next.set(args.model.id, {
        ...base,
        status: "loading",
        voxelBuild: existing?.voxelBuild ?? null,
        attempt: args.status.attempt ?? existing?.attempt ?? 1,
      });
      return next;
    });
  }

  async function watchCustomBuild(args: {
    model: SelectedLiveModel;
    statusUrl: string;
    pageUrl: string;
    eventsUrl: string;
    signal: AbortSignal;
  }) {
    let consecutiveFailures = 0;
    let viewerFailures = 0;
    while (!args.signal.aborted) {
      let status: SavedGenerationPayload;
      try {
        status = await readCustomBuildStatus(args.statusUrl, args.signal);
        consecutiveFailures = 0;
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof CustomBuildStatusReadError && !error.retryable) throw error;
        consecutiveFailures += 1;
        await abortableDelay(
          Math.min(10_000, 1_000 * (2 ** Math.min(consecutiveFailures - 1, 3))),
          args.signal,
        );
        continue;
      }
      if (args.signal.aborted) return;
      if (status.status === "succeeded") {
        applyCustomBuildStatus({
          model: args.model,
          status,
          pageUrl: args.pageUrl,
          statusUrl: args.statusUrl,
          eventsUrl: args.eventsUrl,
        });
        try {
          const viewer = await readCustomBuildViewer(status, args.signal);
          if (args.signal.aborted) return;
          applyCustomBuildStatus({
            model: args.model,
            status,
            build: viewer,
            pageUrl: args.pageUrl,
            statusUrl: args.statusUrl,
            eventsUrl: args.eventsUrl,
          });
        } catch (error) {
          if (isAbortError(error)) return;
          if (error instanceof CustomBuildViewerReadError && error.retryable) {
            viewerFailures += 1;
            await abortableDelay(
              Math.min(10_000, 1_000 * (2 ** Math.min(viewerFailures - 1, 3))),
              args.signal,
            );
            continue;
          }
          console.warn("Custom build viewer unavailable", error);
        }
        return;
      }

      applyCustomBuildStatus({
        model: args.model,
        status,
        pageUrl: args.pageUrl,
        statusUrl: args.statusUrl,
        eventsUrl: args.eventsUrl,
      });
      if (status.status === "failed" || status.status === "canceled") return;
      await abortableDelay(2500, args.signal);
    }
  }

  async function retryCustomBuild(model: SelectedLiveModel) {
    const existing = results.get(model.id);
    if (running || !existing?.customBuildId || !existing.customBuildRetryable) return;
    const providerKey = existing.retryProvider
      ? providerKeys[existing.retryProvider]?.trim()
      : undefined;
    const abortController = new AbortController();
    customBuildAbortRef.current = abortController;
    setRunning(true);
    setRequestError(null);
    try {
      const response = await fetch(
        `/api/generations/${encodeURIComponent(existing.customBuildId)}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            ...(providerKey ? { providerKey } : {}),
            ...(model.kind === "custom" && model.provider === "custom"
              ? { customBaseUrl: model.baseUrl }
              : {}),
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await readClientErrorResponse(response, "Generation could not be retried."));
      }
      const status = ((await response.json()) as { generation: SavedGenerationPayload }).generation;
      setResults((current) => {
        const next = new Map(current);
        const value = next.get(model.id);
        if (value) next.set(model.id, { ...value, startedAt: Date.now() });
        return next;
      });
      const statusUrl = customBuildStatusPath(status.id);
      applyCustomBuildStatus({
        model,
        status,
        statusUrl,
        pageUrl: `/account#${encodeURIComponent(status.id)}`,
      });
      await watchCustomBuild({
        model,
        statusUrl,
        pageUrl: `/account#${encodeURIComponent(status.id)}`,
        eventsUrl: "",
        signal: abortController.signal,
      });
    } catch (error) {
      if (!isAbortError(error)) {
        setRequestError(error instanceof Error ? error.message : "Generation could not be retried.");
      }
    } finally {
      if (customBuildAbortRef.current === abortController) customBuildAbortRef.current = null;
      setRunning(false);
    }
  }

  async function runGenerateDurable(args: {
    abortController: AbortController;
    providerKeys: ProviderApiKeys;
    prompt: string;
    runId: number;
  }) {
    customBuildAbortRef.current = args.abortController;
    const res = await fetch("/api/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: args.abortController.signal,
      body: JSON.stringify({
        prompt: args.prompt,
        gridSize,
        palette,
        models: selectedModels.map(customBuildRequestModel),
        providerKeys: args.providerKeys,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const obj = safeJsonParseObject(text);
      const message =
        obj && typeof obj.error === "object" && obj.error &&
        "message" in obj.error && typeof (obj.error as { message?: unknown }).message === "string"
          ? (obj.error as { message: string }).message
          : text || "Request failed";
      throw new Error(message);
    }
    const created = (await res.json()) as SavedGenerationCreateResponse;
    if (created.generations.length !== selectedModels.length) {
      throw new Error("Generation queue returned an incomplete result.");
    }
    if (canceledDurableRunsRef.current.has(args.runId)) {
      const responses = await Promise.all(created.generations.map((generation) =>
        fetch(`/api/generations/${encodeURIComponent(generation.id)}/cancel`, { method: "POST" }),
      ));
      if (responses.some((response) => !response.ok)) {
        throw new Error("Generation could not be stopped.");
      }
      return;
    }
    setResults((prev) => {
      const next = new Map(prev);
      selectedModels.forEach((model, index) => {
        const generation = created.generations[index];
        if (!generation) return;
        const existing = next.get(model.id);
        next.set(model.id, {
          modelKey: model.id,
          status: "loading",
          voxelBuild: null,
          attempt: 1,
          startedAt: existing?.startedAt ?? Date.now(),
          customBuildId: generation.id,
          customBuildPageUrl: `/account#${encodeURIComponent(generation.id)}`,
          customBuildStatusUrl: customBuildStatusPath(generation.id),
          renderGridSize: gridSize,
          renderPalette: palette,
          currentStage: "Queued",
          submittedPrompt: existing?.submittedPrompt ?? args.prompt,
        });
      });
      return next;
    });
    await Promise.all(
      selectedModels.map((model, index) => {
        const generation = created.generations[index];
        if (!generation) return Promise.resolve();
        const statusUrl = customBuildStatusPath(generation.id);
        return watchCustomBuild({
          model,
          statusUrl,
          pageUrl: `/account#${encodeURIComponent(generation.id)}`,
          eventsUrl: "",
          signal: args.abortController.signal,
        }).catch((err) => {
          if (isAbortError(err)) return;
          setResults((prev) => {
            const next = new Map(prev);
            const existing = next.get(model.id);
            next.set(model.id, {
              ...existing,
              modelKey: model.id,
              status: "error",
              voxelBuild: existing?.voxelBuild ?? null,
              error: err instanceof Error ? err.message : "Status unavailable",
            });
            return next;
          });
        });
      }),
    );
  }

  async function runGenerate(continueTransient = false) {
    if (!prompt.trim() || selectedModels.length === 0) return;
    const submittedPrompt = prompt.trim();

    const invalidCustomModel = selectedModels.find(
      (model) => model.kind === "custom" && !model.modelId.trim()
    );
    if (invalidCustomModel) {
      setRequestError(`Enter a model ID for ${invalidCustomModel.displayName}.`);
      return;
    }
    const missingCustomUrl = selectedModels.some(
      (model) => model.kind === "custom" && model.provider === "custom" && !model.baseUrl,
    );
    if (missingCustomUrl) {
      setRequestError("Enter a chat completions URL for the OpenAI-compatible model.");
      return;
    }
    if (!signedIn && !continueTransient) {
      setShowGenerationPreflight(true);
      return;
    }
    const durableRunId = signedIn ? durableRunSequenceRef.current + 1 : null;
    if (durableRunId !== null) {
      durableRunSequenceRef.current = durableRunId;
      activeDurableRunRef.current = durableRunId;
    }

    setRunning(true);
    lastGenerateInputRef.current = inputSignature;
    setRequestError(null);
    forceRender((c) => c + 1);
    setResults((prev) => {
      const next = new Map(prev);
      const now = Date.now();
      for (const model of selectedModels) {
        next.set(model.id, {
          modelKey: model.id,
          status: "loading",
          voxelBuild: null,
          attempt: 0,
          retryReason: undefined,
          metrics: undefined,
          startedAt: now,
          submittedPrompt,
        });
      }
      return next;
    });

    const abortController = new AbortController();
    generateAbortRef.current = abortController;
    try {
      const requestModels = selectedModels.map(customBuildRequestModel);
      const sanitizedKeys = selectGenerationProviderKeys(requestModels, providerKeys);

      if (signedIn) {
        await runGenerateDurable({
          abortController,
          providerKeys: sanitizedKeys,
          prompt: submittedPrompt,
          runId: durableRunId!,
        });
        return;
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          prompt: submittedPrompt,
          gridSize,
          palette,
          models: requestModels,
          providerKeys: sanitizedKeys,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(await readClientErrorResponse(res, "Request failed"));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: GenerateEvent | null = null;
          try {
            evt = JSON.parse(line) as GenerateEvent;
          } catch (e) {
            console.warn("Failed to parse NDJSON line", e);
            continue;
          }
          if (evt.type === "hello" || evt.type === "ping") continue;

          if (evt.type === "start") {
            setResults((prev) => {
              const next = new Map(prev);
              const existing = next.get(evt.modelKey);
              next.set(evt.modelKey, {
                modelKey: evt.modelKey,
                status: "loading",
                voxelBuild: null,
                attempt: 1,
                rawText: "",
                startedAt: existing?.startedAt ?? Date.now(),
                submittedPrompt: existing?.submittedPrompt ?? submittedPrompt,
              });
              return next;
            });
            continue;
          }

          if (evt.type === "retry") {
            setResults((prev) => {
              const next = new Map(prev);
              const existing = next.get(evt.modelKey);
              next.set(evt.modelKey, {
                modelKey: evt.modelKey,
                status: "loading",
                voxelBuild: null,
                attempt: evt.attempt,
                retryReason: evt.reason,
                rawText: "",
                startedAt: existing?.startedAt ?? Date.now(),
                submittedPrompt: existing?.submittedPrompt ?? submittedPrompt,
              });
              return next;
            });
          } else if (evt.type === "delta") {
            if (!evt.delta) continue;
            setResults((prev) => {
              const next = new Map(prev);
              const existing = next.get(evt.modelKey);
              const prevText = existing?.rawText ?? "";
              let nextText = prevText + evt.delta;
              if (nextText.length > MAX_LIVE_RAW_TEXT_CHARS) {
                nextText = nextText.slice(nextText.length - MAX_LIVE_RAW_TEXT_CHARS);
              }
              next.set(evt.modelKey, {
                modelKey: evt.modelKey,
                status: existing?.status ?? "loading",
                voxelBuild: existing?.voxelBuild ?? null,
                attempt: existing?.attempt,
                retryReason: existing?.retryReason,
                metrics: existing?.metrics,
                startedAt: existing?.startedAt,
                rawText: nextText,
                error: existing?.error,
                submittedPrompt: existing?.submittedPrompt ?? submittedPrompt,
              });
              return next;
            });
          } else if (evt.type === "result") {
            setResults((prev) => {
              const next = new Map(prev);
              const existing = next.get(evt.modelKey);
              next.set(evt.modelKey, {
                modelKey: evt.modelKey,
                status: "success",
                voxelBuild: evt.voxelBuild,
                attempt: existing?.attempt,
                retryReason: undefined,
                metrics: evt.metrics,
                startedAt: existing?.startedAt,
                rawText: existing?.rawText,
                submittedPrompt: existing?.submittedPrompt ?? submittedPrompt,
              });
              return next;
            });
          } else if (evt.type === "error") {
            setResults((prev) => {
              const next = new Map(prev);
              const existing = next.get(evt.modelKey);
              next.set(evt.modelKey, {
                modelKey: evt.modelKey,
                status: "error",
                voxelBuild: null,
                error: evt.message,
                rawText: evt.rawText ?? existing?.rawText,
                startedAt: existing?.startedAt,
                submittedPrompt: existing?.submittedPrompt ?? submittedPrompt,
              });
              return next;
            });
          }
        }
      }

      setResults((prev) => {
        const next = new Map(prev);
        for (const model of selectedModels) {
          const r = next.get(model.id);
          if (!r) continue;
          if (r.status === "loading") {
            next.set(model.id, {
              ...r,
              status: "error",
              voxelBuild: null,
              error: r.error ?? "Stream ended before a result was received",
            });
          }
        }
        return next;
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setRequestError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (customBuildAbortRef.current === abortController) {
        customBuildAbortRef.current = null;
      }
      if (durableRunId !== null) {
        canceledDurableRunsRef.current.delete(durableRunId);
        if (activeDurableRunRef.current === durableRunId) {
          activeDurableRunRef.current = null;
        }
      }
      if (generateAbortRef.current === abortController) {
        generateAbortRef.current = null;
        setRunning(false);
      }
    }
  }

  function getPreviewBuild(
    modelKey: string,
    rawText: string | undefined,
    previewGridSize: GridSize,
    previewPalette: Palette,
  ): VoxelBuild | null {
    if (!rawText) return null;
    const now = Date.now();
    const cacheKey = `${modelKey}:${previewGridSize}:${previewPalette}`;
    const cached = previewCacheRef.current.get(cacheKey);
    const textLen = rawText.length;
    if (cached && now - cached.at < PREVIEW_THROTTLE_MS && textLen <= cached.textLen + 80) {
      return cached.build;
    }
    const build = buildPreviewFromRawText({ rawText, gridSize: previewGridSize, palette: previewPalette });
    previewCacheRef.current.set(cacheKey, { at: now, textLen, build });
    return build;
  }

  const compareTargets: SandboxGifExportTarget[] = selectedModels
    .map((model, idx) => {
      const result = results.get(model.id);
      if (result?.status !== "success") return null;
      const viewerRef = idx === 0 ? viewerARef : viewerBRef;
      return {
        viewerRef,
        modelName: model.displayName,
        company: model.providerLabel,
        blockCount: result.metrics?.blockCount ?? 0,
        generationTimeMs: result.metrics?.generationTimeMs,
        jsonBytes: getResultJsonBytes(result),
      };
    })
    .filter((target) => target !== null);
  const comparePrompt = selectedModels
    .map((model) => results.get(model.id)?.submittedPrompt)
    .find((value): value is string => Boolean(value)) ?? prompt;
  const singleGalleryResult = selectedModels.length === 1
    ? results.get(selectedModels[0]!.id)
    : undefined;

  const resultCards = selectedModels.map((model, idx) => {
    const r = results.get(model.id);
    const viewerRef = idx === 0 ? viewerARef : viewerBRef;
    const modelName = model.displayName;
    const providerName = model.providerLabel;
    const isDurableResult = Boolean(r?.customBuildId);
    const rawBuildJsonForExport = getRawBuildJsonForExport({
      voxelBuild: isDurableResult ? undefined : r?.voxelBuild ?? undefined,
      rawJsonText: isDurableResult ? undefined : r?.rawText,
    });
    const hasJsonExport = Boolean(rawBuildJsonForExport);
    const gifTargets: SandboxGifExportTarget[] =
      r?.status === "success"
        ? [
            {
              viewerRef,
              modelName,
              company: providerName,
              blockCount: r.metrics?.blockCount ?? 0,
              generationTimeMs: r.metrics?.generationTimeMs,
              jsonBytes: getResultJsonBytes(r),
            },
          ]
        : [];
    const elapsedMs =
      r?.status === "loading" && r.startedAt ? Math.max(0, Date.now() - r.startedAt) : undefined;
    const liveRawText = r?.rawText;
    const cardGridSize = r?.renderGridSize ?? gridSize;
    const cardPalette = r?.renderPalette ?? palette;
    const resultPrompt = r?.submittedPrompt ?? prompt;
    const previewBuild = r?.status === "loading" ? getPreviewBuild(model.id, r.rawText, cardGridSize, cardPalette) : null;
    return (
      <VoxelViewerCard
        key={model.id}
        title={model.displayName}
        subtitle={providerName}
        voxelBuild={r?.status === "success" ? r.voxelBuild : previewBuild}
        gridSize={cardGridSize}
        animateIn={r?.status === "success"}
        isLoading={r?.status === "loading"}
        error={r?.status === "error" ? r.error : undefined}
        debugRawText={isDurableResult ? undefined : liveRawText}
        attempt={r?.status === "loading" ? r.attempt : undefined}
        retryReason={r?.status === "loading" || r?.status === "error" ? r.retryReason : undefined}
        elapsedMs={elapsedMs}
        metrics={r?.status === "success" ? r.metrics : undefined}
        jsonBytes={r?.status === "success" ? r.customBuildExpandedBytes : undefined}
        jsonText={isDurableResult ? undefined : r?.rawText}
        loadingMessage={isDurableResult ? r?.currentStage : undefined}
        palette={cardPalette}
        viewerRef={viewerRef}
        skipValidation={isDurableResult}
        onBuildMetrics={
          r?.status === "success"
            ? (metrics) => enqueueVoxelMetric("sandbox", "full", metrics)
            : undefined
        }
        enableBuildJsonToggle={!isDurableResult}
        enableBuildExport={r?.status === "success" && !isDurableResult}
        exportLabel={modelName}
        exportPrompt={resultPrompt}
        actions={
          <>
            {r?.status === "error" && r.customBuildRetryable ? (
              <button
                type="button"
                disabled={running}
                className="mb-btn mb-btn-ghost h-8 px-3 text-xs"
                onClick={() => void retryCustomBuild(model)}
              >
                Retry
              </button>
            ) : null}
            {selectedModels.length > 1 && r?.status === "success" && r.customBuildId && !gallerySuspended ? (
              <GenerationGalleryButton
                key={r.customBuildId}
                generationId={r.customBuildId}
                postAnonymously={!hasPublicNickname}
                canChooseAttribution={hasPublicNickname}
                onError={setRequestError}
                compact
              />
            ) : null}
            {r?.customBuildPageUrl ? (
              <Link
                className="mb-btn mb-btn-ghost h-8 px-3 text-xs"
                href={r.customBuildPageUrl}
              >
                Builds
              </Link>
            ) : null}
            {r?.customBuildDownloadUrl ? (
              <button
                type="button"
                aria-label="Download JSON"
                title="Download JSON"
                className="mb-btn mb-btn-ghost h-8 w-8 border border-border/70 bg-bg/55 p-0 text-muted hover:text-fg"
                onClick={() => {
                  setRequestError(null);
                  void downloadSavedGenerationJson({
                    url: r.customBuildDownloadUrl!,
                    fileName: `${r.customBuildId ?? "minebench-build"}.json`,
                    expandedBytes: r.customBuildExpandedBytes,
                  }).catch(() => setRequestError("JSON could not be downloaded."));
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
                  <path
                    d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                aria-label="Export JSON"
                title={hasJsonExport ? "Export JSON" : "No JSON to export yet"}
                disabled={!hasJsonExport}
                className="mb-btn mb-btn-ghost h-8 w-8 border border-border/70 bg-bg/55 p-0 text-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() =>
                  exportModelJson({
                    modelName,
                    modelKey: model.id,
                    promptText: resultPrompt,
                    rawBuildJson: rawBuildJsonForExport ?? undefined,
                  })
                }
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
                  <path
                    d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                </svg>
              </button>
            )}
            <SandboxGifExportButton
              targets={gifTargets}
              promptText={r?.submittedPrompt ?? prompt}
              cancelKey={`${inputSignature}:${model.id}:${r?.status ?? "idle"}:${r?.metrics?.blockCount ?? 0}`}
              iconOnly
              embedded
              className="h-8 w-8"
              label="Export GIF"
            />
          </>
        }
      />
    );
  });

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(21rem,0.56fr)_minmax(0,1fr)]">
      <div className="mb-panel flex h-fit flex-col gap-5 p-4 sm:p-5">
        <div className="flex flex-col gap-1.5">
          <div className="font-display text-2xl font-semibold tracking-tight">Generate</div>
          <div className="text-sm text-muted">Build from your own prompt.</div>
        </div>

        <label className="flex flex-col gap-2">
          <span className="mb-eyebrow">Prompt</span>
          <textarea
            className="mb-field min-h-36 resize-none py-3"
            placeholder="Describe the build..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <section>
          <div className="mb-eyebrow">Build</div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1">
              <div className="text-xs font-medium text-muted">Size</div>
              <select
                className="mb-field h-10 w-full"
                value={gridSize}
                onChange={(e) => setGridSize(Number(e.target.value) as GridSize)}
              >
                <option value={64}>64</option>
                <option value={256}>256</option>
                <option value={512}>512</option>
              </select>
            </label>

            <label className="flex min-w-0 flex-col gap-1">
              <div className="text-xs font-medium text-muted">Palette</div>
              <select
                className="mb-field h-10 w-full"
                value={palette}
                onChange={(e) => setPalette(e.target.value as Palette)}
              >
                <option value="simple">Simple</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
          </div>
        </section>

        <section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="mb-eyebrow">Model</div>
            <button
              type="button"
              aria-pressed={compareEnabled}
              onClick={() => setCompareEnabled((v) => !v)}
              disabled={running || !canCompare}
              className={`mb-btn h-7 px-2.5 text-[11px] ${compareEnabled ? "mb-btn-primary" : "mb-btn-ghost"} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {compareEnabled ? "Single" : "Compare"}
            </button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3">
            <label className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted">{compareEnabled ? "Model A" : "Model"}</div>
              <select
                className="mb-field h-11 w-full"
                value={modelPair.a}
                onChange={(e) => handleModelChange("a", e.target.value)}
                disabled={running}
              >
                {modelGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((model) => (
                      <option
                        key={model.key}
                        value={model.key}
                        disabled={
                          compareEnabled &&
                          modelPair.b != null &&
                          !isAdHocModelValue(modelPair.b) &&
                          model.key === modelPair.b
                        }
                      >
                        {modelOptionLabel(model)}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <optgroup label="OpenRouter">
                  <option
                    value={OPENROUTER_MODEL_VALUE}
                    disabled={compareEnabled && isAdHocModelValue(modelPair.b)}
                  >
                    Other OpenRouter model
                  </option>
                </optgroup>
                <optgroup label="Custom">
                  <option
                    value={CUSTOM_MODEL_VALUE}
                    disabled={compareEnabled && isAdHocModelValue(modelPair.b)}
                  >
                    OpenAI-compatible model
                  </option>
                </optgroup>
              </select>
            </label>

            {compareEnabled ? (
              <label className="flex flex-col gap-1">
                <div className="text-xs font-medium text-muted">Model B</div>
                <select
                  className="mb-field h-11 w-full"
                  value={modelPair.b ?? ""}
                  onChange={(e) => handleModelChange("b", e.target.value)}
                  disabled={running || !canCompare}
                >
                  <option value="" disabled>
                    Select model
                  </option>
                  {modelGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((model) => (
                        <option
                          key={model.key}
                          value={model.key}
                          disabled={!isAdHocModelValue(modelPair.a) && model.key === modelPair.a}
                        >
                          {modelOptionLabel(model)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  <optgroup label="OpenRouter">
                    <option value={OPENROUTER_MODEL_VALUE} disabled={isAdHocModelValue(modelPair.a)}>
                      Other OpenRouter model
                    </option>
                  </optgroup>
                  <optgroup label="Custom">
                    <option value={CUSTOM_MODEL_VALUE} disabled={isAdHocModelValue(modelPair.a)}>
                      OpenAI-compatible model
                    </option>
                  </optgroup>
                </select>
              </label>
            ) : null}
          </div>

          {usesAdHocModel ? (
            <div className="mt-3 rounded-md border border-border/70 bg-bg/35 p-3">
              <div className="text-xs font-medium text-muted">
                {usesOpenRouterModel ? "OpenRouter model" : "OpenAI-compatible model"}
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3">
                {usesOpenAiCompatibleModel ? (
                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Display name</div>
                    <input
                      className="mb-field h-10 w-full"
                      value={customModel.displayName}
                      onChange={(e) => updateCustomModel({ displayName: e.target.value })}
                      disabled={running}
                      placeholder="My model"
                    />
                  </label>
                ) : null}
                <label className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-muted">Model ID</div>
                  <input
                    className="mb-field h-10 w-full"
                    value={customModel.modelId}
                    onChange={(e) => updateCustomModel({ modelId: e.target.value })}
                    disabled={running}
                    placeholder={usesOpenRouterModel ? "stealth/ox-alpha" : undefined}
                  />
                </label>
                {usesOpenAiCompatibleModel ? (
                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Chat completions URL</div>
                    <input
                      className="mb-field h-10 w-full"
                      value={customModel.baseUrl}
                      onChange={(e) => updateCustomModel({ baseUrl: e.target.value })}
                      disabled={running}
                      type="url"
                    />
                  </label>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        {requestError ? (
          <div className="rounded-md border border-danger/30 bg-danger/[0.08] px-3 py-2 text-xs text-danger">
            {requestError}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-5">
          {singleGalleryResult?.status === "success" && singleGalleryResult.customBuildId && !gallerySuspended ? (
            <GenerationGalleryButton
              key={singleGalleryResult.customBuildId}
              generationId={singleGalleryResult.customBuildId}
              postAnonymously={!hasPublicNickname}
              canChooseAttribution={hasPublicNickname}
              onError={setRequestError}
            />
          ) : null}
          {selectedModels.length > 1 && compareTargets.length === selectedModels.length ? (
            <SandboxGifExportButton
              targets={compareTargets}
              promptText={comparePrompt}
              cancelKey={`${inputSignature}:${compareTargets
                .map((target) => `${target.modelName}:${target.blockCount}`)
                .join("|")}`}
              label="Export comparison GIF"
            />
          ) : null}
          <button
            className={`mb-btn ml-auto h-11 min-w-[160px] disabled:cursor-not-allowed disabled:opacity-50 ${running ? "" : "mb-btn-primary"}`}
            disabled={!running && (selectedModels.length === 0 || !prompt.trim())}
            onClick={running ? stopGenerate : () => void runGenerate()}
          >
            {running ? "Stop" : "Generate"}
          </button>
        </div>
      </div>

      <div className={`grid min-w-0 grid-cols-1 gap-4 ${selectedModels.length > 1 ? "2xl:grid-cols-2" : ""}`}>
        {resultCards}
      </div>

      <section className="border-t border-border/70 xl:col-span-2">
        <button
          type="button"
          aria-expanded={apiKeysOpen}
          aria-controls="sandbox-api-keys"
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-1 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => setApiKeysOpen((open) => !open)}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-semibold text-fg">API keys</span>
            <span className="truncate text-xs text-muted">
              {savedKeyCount ? `${savedKeyCount} saved in this browser` : "None saved"}
            </span>
          </span>
          <svg
            aria-hidden="true"
            className={`mb-disclosure-chevron h-3 w-3 shrink-0 text-muted ${apiKeysOpen ? "is-open" : ""}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6.5L8 10.5L12 6.5" />
          </svg>
        </button>

        {apiKeysOpen ? (
          <div id="sandbox-api-keys" className="mb-fade-in pb-4 pt-2">
            <div className="flex min-h-11 items-center justify-end gap-4">
              {savedKeyCount ? (
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center rounded-sm px-1 text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                  onClick={() => {
                    setProviderKeys({});
                    setRequestError(null);
                  }}
                  disabled={running}
                >
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                aria-pressed={showKeys}
                className="inline-flex min-h-11 items-center rounded-sm px-1 text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                onClick={() => setShowKeys((visible) => !visible)}
                disabled={running}
              >
                {showKeys ? "Hide" : "Show"}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <label className="flex flex-col gap-1">
                <div className="text-xs font-medium text-muted">OpenRouter</div>
                <input
                  className="mb-field h-10 w-full"
                  type={showKeys ? "text" : "password"}
                  value={providerKeys.openrouter ?? ""}
                  onChange={(event) =>
                    setProviderKeys((current) => ({ ...current, openrouter: event.target.value }))
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste key"
                />
              </label>

              {usesOpenAiCompatibleModel ? (
                <label className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-muted">OpenAI-compatible</div>
                  <input
                    className="mb-field h-10 w-full"
                    type={showKeys ? "text" : "password"}
                    value={providerKeys.custom ?? ""}
                    onChange={(event) =>
                      setProviderKeys((current) => ({ ...current, custom: event.target.value }))
                    }
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste key"
                  />
                </label>
              ) : null}
            </div>

            <div className="mt-5 border-t border-border/70 pt-2">
              <button
                type="button"
                aria-expanded={providerKeysOpen}
                aria-controls="sandbox-provider-keys"
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-1 text-left text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:transition-none"
                onClick={() => setProviderKeysOpen((open) => !open)}
              >
                Provider keys
                <svg
                  aria-hidden="true"
                  className={`mb-disclosure-chevron h-3 w-3 shrink-0 ${providerKeysOpen ? "is-open" : ""}`}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 6.5L8 10.5L12 6.5" />
                </svg>
              </button>

              {providerKeysOpen ? (
                <div
                  id="sandbox-provider-keys"
                  className="mb-fade-in grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
                >
                  {DIRECT_PROVIDER_KEYS.map(([provider, label]) => (
                    <label key={provider} className="flex flex-col gap-1">
                      <div className="text-xs font-medium text-muted">{label}</div>
                      <input
                        className="mb-field h-10 w-full"
                        type={showKeys ? "text" : "password"}
                        value={providerKeys[provider] ?? ""}
                        onChange={(event) =>
                          setProviderKeys((current) => ({ ...current, [provider]: event.target.value }))
                        }
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Paste key"
                      />
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <GenerationPreflightDialog
        open={showGenerationPreflight}
        signInHref={`/sign-in?next=${encodeURIComponent(`/sandbox?mode=live&prompt=${encodeURIComponent(prompt)}`)}`}
        onClose={() => setShowGenerationPreflight(false)}
        onContinue={() => {
          setShowGenerationPreflight(false);
          void runGenerate(true);
        }}
      />
      <HostedGeminiAnnouncement
        open={showHostedGeminiAnnouncement}
        onDismiss={dismissHostedGeminiAnnouncement}
      />
    </div>
  );
}
