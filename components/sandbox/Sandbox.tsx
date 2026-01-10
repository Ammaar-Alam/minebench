"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MODEL_CATALOG, ModelKey } from "@/lib/ai/modelCatalog";
import type { GenerateEvent } from "@/lib/ai/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import type { VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import { getPalette } from "@/lib/blocks/palettes";

type Palette = "simple" | "advanced";
type GridSize = 64 | 256 | 512;

type ModelResult = {
  modelKey: ModelKey;
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

function groupByProvider() {
  const groups = new Map<string, { key: string; label: string; models: typeof MODEL_CATALOG }>();
  for (const m of MODEL_CATALOG) {
    if (!m.enabled) continue;
    const g = groups.get(m.provider) ?? {
      key: m.provider,
      label: m.provider,
      models: [],
    };
    g.models.push(m);
    groups.set(m.provider, g);
  }
  return Array.from(groups.values());
}

export function Sandbox({ initialPrompt }: { initialPrompt?: string }) {
  const [prompt, setPrompt] = useState(() => initialPrompt ?? "a pirate ship with sails");
  const [gridSize, setGridSize] = useState<GridSize>(256);
  const [palette, setPalette] = useState<Palette>("simple");
  const [selectedModelKeys, setSelectedModelKeys] = useState<ModelKey[]>(
    ["openai_gpt_5_mini", "gemini_3_0_flash"]
  );
  const [results, setResults] = useState<Map<ModelKey, ModelResult>>(
    () =>
      new Map(
        MODEL_CATALOG.map((m) => [
          m.key,
          { modelKey: m.key, status: "idle", voxelBuild: null } as ModelResult,
        ])
      )
  );
  const [running, setRunning] = useState(false);
  const [, forceRender] = useState(0);
  const previewCacheRef = useRef(
    new Map<ModelKey, { at: number; textLen: number; build: VoxelBuild | null }>()
  );

  const providers = useMemo(() => groupByProvider(), []);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => forceRender((c) => c + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);

  function toggleModel(key: ModelKey) {
    setSelectedModelKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : prev.length >= 2 ? prev : [...prev, key]
    );
  }

  async function runGenerate() {
    if (!prompt.trim() || selectedModelKeys.length !== 2) return;

    setRunning(true);
    forceRender((c) => c + 1);
    setResults((prev) => {
      const next = new Map(prev);
      const now = Date.now();
      for (const key of selectedModelKeys) {
        next.set(key, {
          modelKey: key,
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
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          gridSize,
          palette,
          modelKeys: selectedModelKeys,
        }),
      });

      if (!res.ok || !res.body) throw new Error(await res.text());

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
                rawText: undefined,
              });
              return next;
            });
          } else if (evt.type === "error") {
            if (evt.rawText) {
              console.warn(`[ai debug] ${evt.modelKey} rawText`, evt.rawText);
            }
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
        for (const key of selectedModelKeys) {
          const r = next.get(key);
          if (!r) continue;
          if (r.status === "loading") {
            next.set(key, {
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
      console.error(err);
    } finally {
      setRunning(false);
    }
  }

  function getPreviewBuild(modelKey: ModelKey, rawText: string | undefined): VoxelBuild | null {
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

  const resultCards = selectedModelKeys.map((key) => {
    const model = MODEL_CATALOG.find((m) => m.key === key);
    const r = results.get(key);
    const elapsedMs =
      r?.status === "loading" && r.startedAt ? Math.max(0, Date.now() - r.startedAt) : undefined;
    const liveRawText =
      r?.status === "loading" || r?.status === "error" ? r.rawText : undefined;
    const previewBuild = r?.status === "loading" ? getPreviewBuild(key, r.rawText) : null;
    return (
      <VoxelViewerCard
        key={key}
        title={model?.displayName ?? key}
        subtitle={model?.provider}
        voxelBuild={r?.status === "success" ? r.voxelBuild : previewBuild}
        animateIn={r?.status === "success"}
        isLoading={r?.status === "loading"}
        error={r?.status === "error" ? r.error : undefined}
        debugRawText={liveRawText}
        attempt={r?.status === "loading" ? r.attempt : undefined}
        retryReason={r?.status === "loading" ? r.retryReason : undefined}
        elapsedMs={elapsedMs}
        metrics={r?.status === "success" ? r.metrics : undefined}
        palette={palette}
      />
    );
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="mb-panel p-5">
        <div className="mb-panel-inner">
          <div className="flex flex-col gap-2">
            <div className="mb-badge w-fit">
              <span className="mb-dot" />
              <span className="text-fg">Sandbox</span>
            </div>
            <div className="font-display text-2xl font-semibold tracking-tight">
              Generate + compare
            </div>
            <div className="text-sm text-muted">
              Write any prompt, pick settings, then watch models finish at different speeds.
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 md:col-span-2">
              <div className="text-xs font-medium text-muted">Prompt</div>
              <textarea
                className="mb-field min-h-24 resize-none py-2"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted">Grid</div>
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
              </div>
            </label>
          </div>

          <div className="mt-5">
            <div className="text-xs font-medium text-muted">Models</div>
            <div className="mt-1 text-xs text-muted">
              <span className="font-mono">{selectedModelKeys.length}/2</span>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
              {providers.map((g) => (
                <div key={g.key} className="mb-subpanel p-4">
                  <div className="text-xs font-semibold text-fg">{g.label}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {g.models.map((m) => {
                      const selected = selectedModelKeys.includes(m.key);
                      const disabled = running || (!selected && selectedModelKeys.length >= 2);
                      return (
                        <button
                          key={m.key}
                          type="button"
                          className="mb-chip"
                          aria-pressed={selected}
                          disabled={disabled}
                          onClick={() => toggleModel(m.key)}
                        >
                          <span
                            aria-hidden="true"
                            className={
                              selected
                                ? "h-2.5 w-2.5 rounded-sm bg-accent shadow-[0_0_0_3px_hsl(var(--accent)_/_0.16)]"
                                : "h-2.5 w-2.5 rounded-sm bg-border/80"
                            }
                          />
                          <span className="truncate">{m.displayName}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end">
            <button
              className="mb-btn mb-btn-primary h-11 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={running || selectedModelKeys.length !== 2 || !prompt.trim()}
              onClick={runGenerate}
            >
              {running ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{resultCards}</div>
    </div>
  );
}
