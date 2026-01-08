"use client";

import { useMemo, useState } from "react";
import { MODEL_CATALOG, ModelKey } from "@/lib/ai/modelCatalog";
import type { GenerateEvent } from "@/lib/ai/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";

type Palette = "simple" | "advanced";
type GridSize = 32 | 64 | 128;

type ModelResult = {
  modelKey: ModelKey;
  status: "idle" | "loading" | "success" | "error";
  voxelBuild: unknown | null;
  error?: string;
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
  const [gridSize, setGridSize] = useState<GridSize>(64);
  const [palette, setPalette] = useState<Palette>("simple");
  const [selectedModelKeys, setSelectedModelKeys] = useState<ModelKey[]>(
    MODEL_CATALOG.filter((m) => m.enabled).slice(0, 3).map((m) => m.key)
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

  const providers = useMemo(() => groupByProvider(), []);

  function toggleModel(key: ModelKey) {
    setSelectedModelKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  async function runGenerate() {
    if (!prompt.trim() || selectedModelKeys.length === 0) return;

    setRunning(true);
    setResults((prev) => {
      const next = new Map(prev);
      for (const key of selectedModelKeys) {
        next.set(key, { modelKey: key, status: "loading", voxelBuild: null });
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
          const evt = JSON.parse(line) as GenerateEvent;
          if (evt.type === "start") continue;

          if (evt.type === "result") {
            setResults((prev) => {
              const next = new Map(prev);
              next.set(evt.modelKey, {
                modelKey: evt.modelKey,
                status: "success",
                voxelBuild: evt.voxelBuild,
              });
              return next;
            });
          } else if (evt.type === "error") {
            setResults((prev) => {
              const next = new Map(prev);
              next.set(evt.modelKey, {
                modelKey: evt.modelKey,
                status: "error",
                voxelBuild: null,
                error: evt.message,
              });
              return next;
            });
          }
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(false);
    }
  }

  const resultCards = selectedModelKeys.map((key) => {
    const model = MODEL_CATALOG.find((m) => m.key === key);
    const r = results.get(key);
    return (
      <VoxelViewerCard
        key={key}
        title={model?.displayName ?? key}
        subtitle={model?.provider}
        voxelBuild={r?.status === "success" ? r.voxelBuild : null}
        isLoading={r?.status === "loading"}
        error={r?.status === "error" ? r.error : undefined}
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
              <span className="hidden text-muted2 sm:inline">
                choose models • stream results
              </span>
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
              <select
                className="mb-field h-10"
                value={gridSize}
                onChange={(e) => setGridSize(Number(e.target.value) as GridSize)}
              >
                <option value={32}>32</option>
                <option value={64}>64</option>
                <option value={128}>128</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted">Palette</div>
              <select
                className="mb-field h-10"
                value={palette}
                onChange={(e) => setPalette(e.target.value as Palette)}
              >
                <option value="simple">Simple</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
          </div>

          <div className="mt-5">
            <div className="text-xs font-medium text-muted">Models</div>
            <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
              {providers.map((g) => (
                <div key={g.key} className="mb-subpanel p-4">
                  <div className="text-xs font-semibold text-fg">{g.label}</div>
                  <div className="mt-3 flex flex-col gap-2">
                    {g.models.map((m) => (
                      <label
                        key={m.key}
                        className="flex items-center gap-2 text-sm text-fg"
                      >
                        <input
                          className="h-4 w-4 accent-accent"
                          type="checkbox"
                          checked={selectedModelKeys.includes(m.key)}
                          onChange={() => toggleModel(m.key)}
                        />
                        <span>{m.displayName}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end">
            <button
              className="mb-btn mb-btn-primary h-11 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={running || selectedModelKeys.length === 0 || !prompt.trim()}
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
