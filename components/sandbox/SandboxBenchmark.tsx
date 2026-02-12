"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SandboxGifExportButton,
  type SandboxGifExportTarget,
} from "@/components/sandbox/SandboxGifExportButton";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";

type Palette = "simple" | "advanced";
type GridSize = 64 | 256 | 512;

type BenchmarkPromptOption = {
  id: string;
  text: string;
  modelCount: number;
};

type BenchmarkModelOption = {
  key: string;
  provider: string;
  displayName: string;
  eloRating: number;
};

type BenchmarkBuild = {
  model: BenchmarkModelOption;
  voxelBuild: unknown;
  metrics: {
    blockCount: number;
    generationTimeMs: number;
  };
};

type BenchmarkResponse = {
  settings: {
    gridSize: number;
    palette: string;
    mode: string;
  };
  prompts: BenchmarkPromptOption[];
  selectedPrompt: {
    id: string;
    text: string;
  } | null;
  models: BenchmarkModelOption[];
  selectedModels: {
    a: string | null;
    b: string | null;
  };
  builds: {
    a: BenchmarkBuild | null;
    b: BenchmarkBuild | null;
  };
};

const DEFAULT_MODEL_A = "openai_gpt_5_2";
const DEFAULT_MODEL_B = "openai_gpt_5_mini";

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "gemini") return "Google";
  if (provider === "moonshot") return "Moonshot";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "xai") return "xAI";
  if (provider === "zai") return "Z.AI";
  if (provider === "meta") return "Meta";
  return provider;
}

function toGridSize(gridSize: number): GridSize {
  if (gridSize === 64 || gridSize === 256 || gridSize === 512) return gridSize;
  return 256;
}

function toPalette(palette: string): Palette {
  return palette === "advanced" ? "advanced" : "simple";
}

async function fetchBenchmarkResponse(args: {
  promptId?: string;
  modelA?: string;
  modelB?: string;
}): Promise<BenchmarkResponse> {
  const params = new URLSearchParams();
  if (args.promptId) params.set("promptId", args.promptId);
  if (args.modelA) params.set("modelA", args.modelA);
  if (args.modelB) params.set("modelB", args.modelB);

  const query = params.toString();
  const url = query ? `/api/sandbox/benchmark?${query}` : "/api/sandbox/benchmark";
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || "Failed to load benchmark comparison data";
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error?: unknown }).error === "string"
      ) {
        message = (parsed as { error: string }).error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as BenchmarkResponse;
}

export function SandboxBenchmark() {
  const [promptId, setPromptId] = useState("");
  const [modelPair, setModelPair] = useState({ a: DEFAULT_MODEL_A, b: DEFAULT_MODEL_B });
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const viewerARef = useRef<VoxelViewerHandle | null>(null);
  const viewerBRef = useRef<VoxelViewerHandle | null>(null);

  const runLoad = useCallback(
    async (
      args: {
        promptId?: string;
        modelA?: string;
        modelB?: string;
      },
      opts?: { initial?: boolean }
    ) => {
      const requestId = ++requestIdRef.current;
      const isInitial = Boolean(opts?.initial);
      if (isInitial) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const nextData = await fetchBenchmarkResponse(args);
        if (requestId !== requestIdRef.current) return;

        setData(nextData);
        setPromptId(nextData.selectedPrompt?.id ?? "");
        setModelPair({
          a: nextData.selectedModels.a ?? "",
          b: nextData.selectedModels.b ?? "",
        });
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load benchmark comparison data");
      } finally {
        if (requestId !== requestIdRef.current) return;
        if (isInitial) setLoading(false);
        else setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    void runLoad(
      {
        modelA: DEFAULT_MODEL_A,
        modelB: DEFAULT_MODEL_B,
      },
      { initial: true }
    );
  }, [runLoad]);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, BenchmarkModelOption[]>();
    for (const model of data?.models ?? []) {
      const key = providerLabel(model.provider);
      const rows = groups.get(key) ?? [];
      rows.push(model);
      groups.set(key, rows);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, models]) => ({ label, models }));
  }, [data?.models]);

  function handlePromptChange(nextPromptId: string) {
    setPromptId(nextPromptId);
    void runLoad(
      {
        promptId: nextPromptId,
        modelA: modelPair.a,
        modelB: modelPair.b,
      },
      { initial: false }
    );
  }

  function handleModelChange(slot: "a" | "b", modelKey: string) {
    if (!modelKey) return;
    const other = slot === "a" ? modelPair.b : modelPair.a;
    if (modelKey === other) return;
    const nextPair = slot === "a" ? { a: modelKey, b: other } : { a: other, b: modelKey };
    setModelPair(nextPair);
    void runLoad(
      {
        promptId,
        modelA: nextPair.a,
        modelB: nextPair.b,
      },
      { initial: false }
    );
  }

  function handleRandomPrompt() {
    if (!data || data.prompts.length === 0) return;
    const candidates = data.prompts.filter((p) => p.id !== promptId);
    const pool = candidates.length > 0 ? candidates : data.prompts;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return;
    handlePromptChange(pick.id);
  }

  const selectedPromptText = data?.selectedPrompt?.text ?? "";
  const gridSize = toGridSize(data?.settings.gridSize ?? 256);
  const palette = toPalette(data?.settings.palette ?? "simple");
  const compareTargets: SandboxGifExportTarget[] = data
    ? (["a", "b"] as const)
        .map((slot) => {
          const build = data.builds[slot];
          if (!build) return null;
          const viewerRef = slot === "a" ? viewerARef : viewerBRef;
          return {
            viewerRef,
            modelName: build.model.displayName,
            company: providerLabel(build.model.provider),
            blockCount: build.metrics.blockCount,
          };
        })
        .filter((target): target is SandboxGifExportTarget => Boolean(target))
    : [];

  const cards = data
    ? (["a", "b"] as const).map((slot) => {
        const build = data.builds[slot];
        const selectedModelKey = slot === "a" ? modelPair.a : modelPair.b;
        const fallbackModel = data.models.find((m) => m.key === selectedModelKey);
        const model = build?.model ?? fallbackModel;
        const viewerRef = slot === "a" ? viewerARef : viewerBRef;
        const title = model ? model.displayName : slot === "a" ? "Model A" : "Model B";

        return (
          <VoxelViewerCard
            key={`${slot}:${model?.key ?? selectedModelKey}`}
            title={title}
            subtitle={
              model ? (
                <span className="inline-flex items-center gap-2 text-xs text-muted">
                  <span className="uppercase tracking-[0.08em]">{providerLabel(model.provider)}</span>
                  <span className="font-mono">Elo {Math.round(model.eloRating)}</span>
                </span>
              ) : (
                <span className="text-xs text-muted">Select a model</span>
              )
            }
            voxelBuild={build?.voxelBuild ?? null}
            gridSize={gridSize}
            palette={palette}
            animateIn
            viewerRef={viewerRef}
            actions={
              build && model ? (
                <SandboxGifExportButton
                  targets={[
                    {
                      viewerRef,
                      modelName: model.displayName,
                      company: providerLabel(model.provider),
                      blockCount: build.metrics.blockCount,
                    },
                  ]}
                  promptText={selectedPromptText}
                  iconOnly
                  label="Export GIF"
                />
              ) : null
            }
            metrics={
              build
                ? {
                    blockCount: build.metrics.blockCount,
                    generationTimeMs: build.metrics.generationTimeMs,
                    warnings: [],
                  }
                : undefined
            }
            error={!build ? "No seeded build found for this model/prompt pair." : undefined}
          />
        );
      })
    : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="mb-panel p-5">
        <div className="mb-panel-inner">
          <div className="flex flex-col gap-2">
            <div className="mb-badge w-fit">
              <span className="mb-dot" />
              <span className="text-fg">Benchmark Compare</span>
            </div>
            <div className="font-display text-2xl font-semibold tracking-tight">
              Compare seeded Arena builds
            </div>
            <div className="text-sm text-muted">
              Pick any curated benchmark prompt and compare two models instantly, with no API keys.
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          ) : null}

          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 md:col-span-2">
              <div className="text-xs font-medium text-muted">Benchmark prompt</div>
              <div className="relative">
                <select
                  className="mb-field h-11 w-full appearance-none pr-10"
                  value={promptId}
                  onChange={(e) => handlePromptChange(e.target.value)}
                  disabled={loading || refreshing || (data?.prompts.length ?? 0) === 0}
                >
                  {(data?.prompts ?? []).map((prompt) => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.text}
                    </option>
                  ))}
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
              <div className="text-xs font-medium text-muted">Model A</div>
              <div className="relative">
                <select
                  className="mb-field h-11 w-full appearance-none pr-10"
                  value={modelPair.a}
                  onChange={(e) => handleModelChange("a", e.target.value)}
                  disabled={loading || refreshing || (data?.models.length ?? 0) < 2}
                >
                  {modelGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((model) => (
                        <option key={model.key} value={model.key} disabled={model.key === modelPair.b}>
                          {model.displayName}
                        </option>
                      ))}
                    </optgroup>
                  ))}
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
              <div className="text-xs font-medium text-muted">Model B</div>
              <div className="relative">
                <select
                  className="mb-field h-11 w-full appearance-none pr-10"
                  value={modelPair.b}
                  onChange={(e) => handleModelChange("b", e.target.value)}
                  disabled={loading || refreshing || (data?.models.length ?? 0) < 2}
                >
                  {modelGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((model) => (
                        <option key={model.key} value={model.key} disabled={model.key === modelPair.a}>
                          {model.displayName}
                        </option>
                      ))}
                    </optgroup>
                  ))}
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

          <div className="mt-4 mb-subpanel p-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="text-xs font-medium text-muted">Selected prompt</div>
                  <div className="text-xs text-muted">
                    <span className="font-mono">
                      {gridSize} grid • {palette} palette • {data?.settings.mode ?? "precise"} mode
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:gap-2">
                  <SandboxGifExportButton
                    targets={compareTargets}
                    promptText={selectedPromptText}
                    label="Export comparison GIF"
                    className="h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs"
                  />

                  <button
                    type="button"
                    className="mb-btn mb-btn-ghost h-8 rounded-full border border-border/70 bg-bg/55 px-2.5 text-[11px] tracking-[0.01em] backdrop-blur-sm hover:bg-bg/70 sm:h-9 sm:px-3 sm:text-xs"
                    onClick={handleRandomPrompt}
                    disabled={loading || refreshing || (data?.prompts.length ?? 0) < 2}
                    title="Pick a random prompt"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
                        <rect
                          x="5"
                          y="5"
                          width="14"
                          height="14"
                          rx="3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                        />
                        <circle cx="9" cy="9" r="1.1" fill="currentColor" />
                        <circle cx="12" cy="12" r="1.1" fill="currentColor" />
                        <circle cx="15" cy="15" r="1.1" fill="currentColor" />
                      </svg>
                      <span>Random</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="mb-btn mb-btn-ghost h-8 rounded-full border border-border/70 bg-bg/55 px-2.5 text-[11px] tracking-[0.01em] backdrop-blur-sm hover:bg-bg/70 sm:h-9 sm:px-3 sm:text-xs"
                    onClick={() =>
                      void runLoad(
                        {
                          promptId,
                          modelA: modelPair.a,
                          modelB: modelPair.b,
                        },
                        { initial: false }
                      )
                    }
                    disabled={loading || refreshing}
                    title="Refresh builds"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                        fill="none"
                      >
                        <path
                          d="M20 12a8 8 0 1 1-2.34-5.66"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.7"
                        />
                        <path
                          d="M20 4v6h-6"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.7"
                        />
                      </svg>
                      <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
                    </span>
                  </button>
                </div>
              </div>

              <div className="text-sm leading-relaxed text-fg">
                {selectedPromptText || "Loading benchmark prompt…"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="mb-panel p-10 text-center text-sm text-muted">Loading benchmark builds…</div>
      ) : null}

      {!loading && data ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{cards}</div> : null}
    </div>
  );
}
