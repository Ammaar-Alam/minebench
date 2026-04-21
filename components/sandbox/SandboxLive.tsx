"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MODEL_CATALOG, ModelKey } from "@/lib/ai/modelCatalog";
import type { GenerateEvent, ProviderApiKeys } from "@/lib/ai/types";
import {
  SandboxGifExportButton,
  type SandboxGifExportTarget,
} from "@/components/sandbox/SandboxGifExportButton";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import type { VoxelBuild } from "@/lib/voxel/types";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";
import { getPalette } from "@/lib/blocks/palettes";

type Palette = "simple" | "advanced";
type GridSize = 64 | 256 | 512;
type SelectedModelValue = ModelKey | typeof CUSTOM_MODEL_VALUE;

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
      displayName: string;
      providerLabel: string;
      modelId: string;
      baseUrl: string;
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
};

const MAX_LIVE_RAW_TEXT_CHARS = 80_000;
const PREVIEW_MAX_BLOCKS = 30_000;
const PREVIEW_THROTTLE_MS = 450;
const PREVIEW_MAX_BOXES = 600;
const PREVIEW_MAX_LINES = 800;
const API_KEYS_STORAGE_KEY = "mb_provider_keys_v1";
const CUSTOM_MODEL_VALUE = "__custom_api__";
const DEFAULT_CUSTOM_API_URL = "https://inference-api.nvidia.com/v1/chat/completions";
const DEFAULT_CUSTOM_MODEL: CustomSandboxModel = {
  displayName: "Custom API model",
  modelId: "",
  baseUrl: DEFAULT_CUSTOM_API_URL,
};
const ENABLED_MODELS = MODEL_CATALOG.filter((model) => model.enabled);
const FALLBACK_MODEL_A: ModelKey = ENABLED_MODELS[0]?.key ?? "openai_gpt_5_4_mini";
const DEFAULT_MODEL_A: ModelKey =
  ENABLED_MODELS.find((model) => model.key === "openai_gpt_5_4_mini")?.key ?? FALLBACK_MODEL_A;
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

function SelectChevron() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
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

function loadProviderKeysFromStorage(): ProviderApiKeys {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(API_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const obj = safeJsonParseObject(raw);
    if (!obj) return {};
    const keys: ProviderApiKeys = {};
    const set = (k: keyof ProviderApiKeys) => {
      const v = obj[k];
      if (typeof v !== "string") return;
      const t = v.trim();
      if (t) keys[k] = t;
    };
    set("openrouter");
    set("openai");
    set("anthropic");
    set("gemini");
    set("moonshot");
    set("deepseek");
    set("minimax");
    set("xai");
    set("custom");
    return keys;
  } catch {
    return {};
  }
}

function saveProviderKeysToStorage(keys: ProviderApiKeys) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // ignore
  }
}

function isCustomModelValue(value: string | null | undefined): value is typeof CUSTOM_MODEL_VALUE {
  return value === CUSTOM_MODEL_VALUE;
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

export function SandboxLive({ initialPrompt }: { initialPrompt?: string }) {
  const [prompt, setPrompt] = useState(() => initialPrompt ?? "a pirate ship with sails");
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
  const [, forceRender] = useState(0);
  const generateAbortRef = useRef<AbortController | null>(null);
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
  const usesCustomModel =
    isCustomModelValue(modelPair.a) || (compareEnabled && isCustomModelValue(modelPair.b));
  const selectedModels = useMemo(() => {
    const picked: SelectedLiveModel[] = [];
    const pushValue = (value: SelectedModelValue | null) => {
      if (!value) return;
      if (isCustomModelValue(value)) {
        picked.push({
          id: "custom",
          kind: "custom",
          displayName: customModel.displayName.trim() || "Custom API model",
          providerLabel: "Custom API",
          modelId: customModel.modelId.trim(),
          baseUrl: customModel.baseUrl.trim() || DEFAULT_CUSTOM_API_URL,
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
    if (compareEnabled && modelPair.b && (!isCustomModelValue(modelPair.b) || !isCustomModelValue(modelPair.a))) {
      pushValue(modelPair.b);
    }
    return picked;
  }, [compareEnabled, customModel, modelPair.a, modelPair.b]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => forceRender((c) => c + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    saveProviderKeysToStorage(providerKeys);
  }, [providerKeys]);

  useEffect(() => {
    if (!compareEnabled) return;
    setModelPair((prev) => {
      if (prev.b && prev.b !== prev.a && !(isCustomModelValue(prev.a) && isCustomModelValue(prev.b))) {
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
          isCustomModelValue(nextValue) ||
          isCustomModelValue(prev.b) ||
          nextValue !== prev.b
        ) {
          return { a: nextValue, b: prev.b };
        }
        const fallback = ENABLED_MODELS.find((model) => model.key !== nextValue)?.key ?? null;
        return { a: nextValue, b: fallback ?? CUSTOM_MODEL_VALUE };
      }
      if (isCustomModelValue(nextValue) && isCustomModelValue(prev.a)) {
        return prev;
      }
      if (
        !isCustomModelValue(nextValue) &&
        !isCustomModelValue(prev.a) &&
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
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
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
    rawBuildJson?: string;
  }) {
    const modelToken = sanitizeFilePart(args.modelName) || args.modelKey;
    const promptToken = sanitizeFilePart(prompt) || "sandbox";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `minebench-build-${modelToken}-${promptToken}-${stamp}.json`;
    const json = typeof args.rawBuildJson === "string" ? args.rawBuildJson.trim() : "";
    if (!json) return;
    triggerDownload(new Blob([json], { type: "application/json" }), fileName);
  }

  async function runGenerate() {
    if (!prompt.trim() || selectedModels.length === 0) return;

    const invalidCustomModel = selectedModels.find(
      (model) => model.kind === "custom" && !model.modelId.trim()
    );
    if (invalidCustomModel) {
      setRequestError(`Enter a model ID for ${invalidCustomModel.displayName}.`);
      return;
    }

    setRunning(true);
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
        });
      }
      return next;
    });

    try {
      const abortController = new AbortController();
      generateAbortRef.current = abortController;
      const sanitizedKeys: ProviderApiKeys = {};
      const setKey = (k: keyof ProviderApiKeys, v: unknown) => {
        if (typeof v !== "string") return;
        const t = v.trim();
        if (t) sanitizedKeys[k] = t;
      };
      setKey("openrouter", providerKeys.openrouter);
      setKey("openai", providerKeys.openai);
      setKey("anthropic", providerKeys.anthropic);
      setKey("gemini", providerKeys.gemini);
      setKey("moonshot", providerKeys.moonshot);
      setKey("deepseek", providerKeys.deepseek);
      setKey("minimax", providerKeys.minimax);
      setKey("xai", providerKeys.xai);
      setKey("custom", providerKeys.custom);

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          prompt,
          gridSize,
          palette,
          models: selectedModels.map((model) =>
            model.kind === "catalog"
              ? {
                  id: model.id,
                  kind: "catalog" as const,
                  modelKey: model.modelKey,
                }
              : {
                  id: model.id,
                  kind: "custom" as const,
                  provider: "custom" as const,
                  displayName: model.displayName,
                  modelId: model.modelId,
                  baseUrl: model.baseUrl,
                }
          ),
          providerKeys: sanitizedKeys,
        }),
      });

      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        const obj = safeJsonParseObject(txt);
        const message = obj && typeof obj.error === "string" ? obj.error : txt || "Request failed";
        throw new Error(message);
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
      generateAbortRef.current = null;
      setRunning(false);
    }
  }

  function getPreviewBuild(modelKey: string, rawText: string | undefined): VoxelBuild | null {
    if (!rawText) return null;
    const now = Date.now();
    const cached = previewCacheRef.current.get(modelKey);
    const textLen = rawText.length;
    if (cached && now - cached.at < PREVIEW_THROTTLE_MS && textLen <= cached.textLen + 80) {
      return cached.build;
    }
    const build = buildPreviewFromRawText({ rawText, gridSize, palette });
    previewCacheRef.current.set(modelKey, { at: now, textLen, build });
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
      };
    })
    .filter((target): target is SandboxGifExportTarget => Boolean(target));

  const resultCards = selectedModels.map((model, idx) => {
    const r = results.get(model.id);
    const viewerRef = idx === 0 ? viewerARef : viewerBRef;
    const modelName = model.displayName;
    const providerName = model.providerLabel;
    const rawBuildJsonForExport = getRawBuildJsonForExport({
      voxelBuild: r?.voxelBuild ?? undefined,
      rawJsonText: r?.rawText,
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
            },
          ]
        : [];
    const elapsedMs =
      r?.status === "loading" && r.startedAt ? Math.max(0, Date.now() - r.startedAt) : undefined;
    const liveRawText = r?.rawText;
    const previewBuild = r?.status === "loading" ? getPreviewBuild(model.id, r.rawText) : null;
    return (
      <VoxelViewerCard
        key={model.id}
        title={model.displayName}
        subtitle={providerName}
        voxelBuild={r?.status === "success" ? r.voxelBuild : previewBuild}
        gridSize={gridSize}
        animateIn={r?.status === "success"}
        isLoading={r?.status === "loading"}
        error={r?.status === "error" ? r.error : undefined}
        debugRawText={liveRawText}
        attempt={r?.status === "loading" ? r.attempt : undefined}
        retryReason={r?.status === "loading" ? r.retryReason : undefined}
        elapsedMs={elapsedMs}
        metrics={r?.status === "success" ? r.metrics : undefined}
        jsonText={r?.rawText}
        palette={palette}
        viewerRef={viewerRef}
        enableBuildJsonToggle
        actions={
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Export JSON"
              title={hasJsonExport ? "Export JSON" : "No JSON to export yet"}
              disabled={!hasJsonExport}
              className="mb-btn mb-btn-ghost h-8 w-8 rounded-full border border-border/70 bg-bg/55 p-0 text-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() =>
                exportModelJson({
                  modelName,
                  modelKey: model.id,
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
            <SandboxGifExportButton
              targets={gifTargets}
              promptText={prompt}
              iconOnly
              label="Export GIF"
            />
          </div>
        }
      />
    );
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="mb-panel p-4 sm:p-5">
        <div className="flex flex-col gap-1.5">
          <div className="font-display text-2xl font-semibold tracking-tight">
            Live generate
          </div>
          <div className="text-sm text-muted">
            Generate a build from your own prompt, or compare two models side by side.
          </div>
        </div>

          <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <section className="flex flex-col">
              <label className="flex flex-col gap-2">
                <span className="mb-eyebrow">Prompt</span>
                <textarea
                  className="mb-field min-h-44 resize-none py-3"
                  placeholder="Describe the build — shape, materials, scale, mood…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>
            </section>

            <div className="flex flex-col gap-5">
              <section>
                <div className="mb-eyebrow">Build settings</div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Size</div>
                    <div className="relative">
                      <select
                        className="mb-field h-10 w-full appearance-none pr-10"
                        value={gridSize}
                        onChange={(e) => setGridSize(Number(e.target.value) as GridSize)}
                      >
                        <option value={64}>64</option>
                        <option value={256}>256</option>
                        <option value={512}>512</option>
                      </select>
                      <SelectChevron />
                    </div>
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Palette</div>
                    <div className="relative">
                      <select
                        className="mb-field h-10 w-full appearance-none pr-10"
                        value={palette}
                        onChange={(e) => setPalette(e.target.value as Palette)}
                      >
                        <option value="simple">Simple</option>
                        <option value="advanced">Advanced</option>
                      </select>
                      <SelectChevron />
                    </div>
                  </label>
                </div>
              </section>

              <section>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="mb-eyebrow">Models</div>
                  <button
                    type="button"
                    aria-pressed={compareEnabled}
                    onClick={() => setCompareEnabled((v) => !v)}
                    disabled={running || !canCompare}
                    className={`mb-btn h-7 rounded-full px-2.5 text-[11px] ${compareEnabled ? "mb-btn-primary" : "mb-btn-ghost"} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {compareEnabled ? "Stop comparing" : "Compare models"}
                  </button>
                </div>

                <div className={`mt-3 grid grid-cols-1 gap-3 ${compareEnabled ? "sm:grid-cols-2" : ""}`}>
                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">{compareEnabled ? "Model A" : "Model"}</div>
                    <div className="relative">
                      <select
                        className="mb-field h-11 w-full appearance-none pr-10"
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
                                  !isCustomModelValue(modelPair.b) &&
                                  model.key === modelPair.b
                                }
                              >
                                {model.displayName}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                        <optgroup label="Custom">
                          <option
                            value={CUSTOM_MODEL_VALUE}
                            disabled={compareEnabled && isCustomModelValue(modelPair.b)}
                          >
                            Custom API model
                          </option>
                        </optgroup>
                      </select>
                      <SelectChevron />
                    </div>
                  </label>

                  {compareEnabled ? (
                    <label className="flex flex-col gap-1">
                      <div className="text-xs font-medium text-muted">Model B</div>
                      <div className="relative">
                        <select
                          className="mb-field h-11 w-full appearance-none pr-10"
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
                                  disabled={!isCustomModelValue(modelPair.a) && model.key === modelPair.a}
                                >
                                  {model.displayName}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                          <optgroup label="Custom">
                            <option value={CUSTOM_MODEL_VALUE} disabled={isCustomModelValue(modelPair.a)}>
                              Custom API model
                            </option>
                          </optgroup>
                        </select>
                        <SelectChevron />
                      </div>
                    </label>
                  ) : null}
                </div>

                {usesCustomModel ? (
                  <div className="mt-3 rounded-xl border border-border/70 bg-bg/35 p-3">
                    <div className="text-xs font-medium text-muted">Custom API model</div>
                    <div className="mt-3 grid grid-cols-1 gap-3">
                      <label className="flex flex-col gap-1">
                        <div className="text-xs font-medium text-muted">Display name</div>
                        <input
                          className="mb-field h-10 w-full"
                          value={customModel.displayName}
                          onChange={(e) => updateCustomModel({ displayName: e.target.value })}
                          disabled={running}
                          placeholder="My custom model"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <div className="text-xs font-medium text-muted">Model ID</div>
                        <input
                          className="mb-field h-10 w-full"
                          value={customModel.modelId}
                          onChange={(e) => updateCustomModel({ modelId: e.target.value })}
                          disabled={running}
                          placeholder="aws/anthropic/bedrock-claude-opus-4-7"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <div className="text-xs font-medium text-muted">API server URL</div>
                        <input
                          className="mb-field h-10 w-full"
                          value={customModel.baseUrl}
                          onChange={(e) => updateCustomModel({ baseUrl: e.target.value })}
                          disabled={running}
                          placeholder={DEFAULT_CUSTOM_API_URL}
                        />
                      </label>
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
          </div>

          <div className="mt-5 border-t border-border/70 pt-4 sm:pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="mb-eyebrow">API keys</div>
                <div className="mt-1 text-xs text-muted">Stored in your browser only.</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="mb-btn mb-btn-ghost h-7 rounded-full px-2.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    setProviderKeys({});
                    setRequestError(null);
                  }}
                  disabled={running}
                >
                  Clear keys
                </button>
                <button
                  type="button"
                  aria-pressed={showKeys}
                  className={`mb-btn h-7 rounded-full px-2.5 text-[11px] ${showKeys ? "mb-btn-primary" : "mb-btn-ghost"} disabled:cursor-not-allowed disabled:opacity-50`}
                  onClick={() => setShowKeys((v) => !v)}
                  disabled={running}
                >
                  {showKeys ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {requestError ? (
              <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {requestError}
              </div>
            ) : null}

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 md:col-span-2">
                <div className="text-xs font-medium text-muted">OpenRouter API key</div>
                <input
                  className="mb-field h-10 w-full"
                  type={showKeys ? "text" : "password"}
                  value={providerKeys.openrouter ?? ""}
                  onChange={(e) => setProviderKeys((prev) => ({ ...prev, openrouter: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your OpenRouter key"
                />
              </label>

              <details className="md:col-span-2 rounded-xl border border-border/70 bg-bg/35 px-3 py-2">
                <summary className="cursor-pointer select-none text-xs font-medium text-muted">
                  Use a provider-specific key instead (optional)
                </summary>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Custom API key</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.custom ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, custom: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste the key for your custom API server"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">OpenAI</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.openai ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, openai: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste your OpenAI key"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Anthropic</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.anthropic ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, anthropic: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste your Anthropic key"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Gemini</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.gemini ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, gemini: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste your Google AI key"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">Moonshot</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.moonshot ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, moonshot: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste your Moonshot key"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">DeepSeek</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.deepseek ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, deepseek: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste your DeepSeek key"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">MiniMax</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.minimax ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, minimax: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste your MiniMax key"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="text-xs font-medium text-muted">xAI</div>
                    <input
                      className="mb-field h-10 w-full"
                      type={showKeys ? "text" : "password"}
                      value={providerKeys.xai ?? ""}
                      onChange={(e) => setProviderKeys((prev) => ({ ...prev, xai: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste your xAI key"
                    />
                  </label>
                </div>
              </details>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-5">
            <SandboxGifExportButton
              targets={compareTargets}
              promptText={prompt}
              label={selectedModels.length > 1 ? "Export comparison GIF" : "Export GIF"}
            />
            <div className="flex items-center gap-2">
              {running ? (
                <button
                  className="mb-btn h-11 min-w-[160px] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={stopGenerate}
                >
                  Stop generating
                </button>
              ) : null}
              <button
                className="mb-btn mb-btn-primary h-11 min-w-[160px] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={running || selectedModels.length === 0 || !prompt.trim()}
                onClick={runGenerate}
              >
                {running ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${selectedModels.length > 1 ? "md:grid-cols-2" : ""}`}>
        {resultCards}
      </div>
    </div>
  );
}
