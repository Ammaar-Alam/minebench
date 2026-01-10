"use client";

import { useEffect, useMemo, useState } from "react";
import { MODEL_CATALOG, ModelKey } from "@/lib/ai/modelCatalog";
import type { GenerateEvent } from "@/lib/ai/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";

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

function groupByProvider() {
  const groups = new Map<string, { key: string; label: string; models: typeof MODEL_CATALOG }>();
  for (const m of MODEL_CATALOG) {
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
                startedAt: existing?.startedAt ?? Date.now(),
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
                rawText: evt.rawText,
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

  const resultCards = selectedModelKeys.map((key) => {
    const model = MODEL_CATALOG.find((m) => m.key === key);
    const r = results.get(key);
    const elapsedMs =
      r?.status === "loading" && r.startedAt ? Math.max(0, Date.now() - r.startedAt) : undefined;
    return (
      <VoxelViewerCard
        key={key}
        title={model?.displayName ?? key}
        subtitle={model?.provider}
        voxelBuild={r?.status === "success" ? r.voxelBuild : null}
        animateIn={r?.status === "success"}
        isLoading={r?.status === "loading"}
        error={r?.status === "error" ? r.error : undefined}
        debugRawText={r?.status === "error" ? r.rawText : undefined}
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
