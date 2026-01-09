"use client";

import { useEffect, useMemo, useState } from "react";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompts";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { getPalette } from "@/lib/blocks/palettes";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";

type Palette = "simple" | "advanced";
type GridSize = 32 | 64 | 128;

const MAX_BLOCKS_BY_GRID: Record<GridSize, number> = {
  32: Math.floor(32 ** 3 * 0.75), // 24,576
  64: Math.floor(64 ** 3 * 0.75), // 196,608
  128: Math.floor(128 ** 3 * 0.75), // 1,572,864
};

const MIN_BLOCKS_BY_GRID: Record<GridSize, number> = {
  32: 80,
  64: 200,
  128: 300,
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function CopyButton({
  label,
  text,
  disabled,
  className,
}: {
  label: string;
  text: string;
  disabled?: boolean;
  className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 1100);
    } catch {
      try {
        const el = document.createElement("textarea");
        el.value = text;
        el.setAttribute("readonly", "true");
        el.style.position = "fixed";
        el.style.left = "-9999px";
        el.style.top = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(el);
        if (!ok) throw new Error("execCommand failed");
        setStatus("copied");
        window.setTimeout(() => setStatus("idle"), 1100);
      } catch {
        setStatus("error");
        window.setTimeout(() => setStatus("idle"), 1400);
      }
    }
  }

  return (
    <button
      type="button"
      className={cx("mb-btn mb-btn-ghost h-9 px-3 text-xs", className)}
      disabled={disabled}
      onClick={copy}
    >
      {status === "copied" ? "Copied" : status === "error" ? "Copy failed" : label}
    </button>
  );
}

export function LocalLab() {
  const [gridSize, setGridSize] = useState<GridSize>(64);
  const [palette, setPalette] = useState<Palette>("simple");

  const defaultSystem = useMemo(() => {
    const minBlocks = MIN_BLOCKS_BY_GRID[gridSize];
    return buildSystemPrompt({
      gridSize,
      minBlocks,
      maxBlocks: MAX_BLOCKS_BY_GRID[gridSize],
      palette,
    });
  }, [gridSize, palette]);

  const [systemPrompt, setSystemPrompt] = useState(() => defaultSystem);
  const [systemIsDefault, setSystemIsDefault] = useState(true);

  useEffect(() => {
    if (!systemIsDefault) return;
    setSystemPrompt(defaultSystem);
  }, [defaultSystem, systemIsDefault]);

  const [taskPrompt, setTaskPrompt] = useState(
    "A warm wooden cabin beside a pond, with a stone chimney, a small dock, and a few trees."
  );
  const userPrompt = useMemo(() => buildUserPrompt(taskPrompt.trim()), [taskPrompt]);

  const combinedPrompt = useMemo(() => {
    return `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`;
  }, [systemPrompt, userPrompt]);

  const [modelOutput, setModelOutput] = useState("");
  const [rendered, setRendered] = useState<{
    kind: "idle" | "ready" | "error";
    build: VoxelBuild | null;
    warnings: string[];
    message?: string;
  }>({ kind: "idle", build: null, warnings: [] });

  function renderFromText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      setRendered({ kind: "error", build: null, warnings: [], message: "Paste a JSON object first." });
      return;
    }

    let json: unknown = null;
    try {
      json = JSON.parse(trimmed) as unknown;
    } catch {
      json = extractBestVoxelBuildJson(trimmed);
    }

    if (!json) {
      setRendered({
        kind: "error",
        build: null,
        warnings: [],
        message: "Could not find a valid JSON object. Paste the raw JSON (no extra text) if possible.",
      });
      return;
    }

    const paletteDefs = getPalette(palette);
    const validated = validateVoxelBuild(json, {
      gridSize,
      palette: paletteDefs,
      maxBlocks: MAX_BLOCKS_BY_GRID[gridSize],
    });

    if (!validated.ok) {
      setRendered({ kind: "error", build: null, warnings: [], message: validated.error });
      return;
    }

    setRendered({
      kind: "ready",
      build: validated.value.build,
      warnings: validated.value.warnings,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="mb-panel p-5">
        <div className="mb-panel-inner flex flex-col gap-3">
          <div className="mb-badge w-fit">
            <span className="mb-dot" />
            <span className="text-fg">Local Lab</span>
            <span className="hidden text-muted2 sm:inline">prompt kit + JSON renderer</span>
          </div>
          <div className="font-display text-2xl font-semibold tracking-tight md:text-3xl">
            Test MineBench locally (no uploads)
          </div>
          <div className="text-sm text-muted">
            Copy the exact system prompt, run it in any model (ChatGPT, Claude, Gemini, local LLMs), then paste the
            resulting JSON here to preview the build.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div className="mb-panel p-5">
            <div className="mb-panel-inner flex flex-col gap-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-fg">Prompt settings</div>
                  <div className="text-xs text-muted">These settings affect the prompt and validation.</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-full bg-bg/55 p-1 ring-1 ring-border/80">
                    {([32, 64, 128] as GridSize[]).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className="mb-chip px-3 py-1 text-xs"
                        aria-pressed={gridSize === g}
                        onClick={() => setGridSize(g)}
                      >
                        {g}³
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 rounded-full bg-bg/55 p-1 ring-1 ring-border/80">
                    {(["simple", "advanced"] as Palette[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="mb-chip px-3 py-1 text-xs"
                        aria-pressed={palette === p}
                        onClick={() => setPalette(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mb-subpanel p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg">System prompt</div>
                    <div className="text-xs text-muted">
                      Paste this into your model as the <span className="font-mono">system</span> instruction.
                      Edit it if you want — this page never uploads anything.
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton label="Copy system" text={systemPrompt} />
                    <button
                      type="button"
                      className="mb-btn mb-btn-ghost h-9 px-3 text-xs"
                      disabled={systemIsDefault}
                      onClick={() => {
                        setSystemPrompt(defaultSystem);
                        setSystemIsDefault(true);
                      }}
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <textarea
                  className="mb-field mt-3 min-h-[240px] font-mono text-[12px] leading-snug"
                  value={systemPrompt}
                  spellCheck={false}
                  onChange={(e) => {
                    setSystemIsDefault(false);
                    setSystemPrompt(e.target.value);
                  }}
                />
              </div>

              <div className="mb-subpanel p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg">User prompt</div>
                    <div className="text-xs text-muted">
                      This is the message you send after the system prompt. Keep it short; let the system prompt enforce
                      structure.
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton label="Copy user" text={userPrompt} disabled={!taskPrompt.trim()} />
                    <CopyButton label="Copy both" text={combinedPrompt} disabled={!taskPrompt.trim()} />
                  </div>
                </div>

                <input
                  className="mb-field mt-3 h-10"
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                />
                <div className="mt-2 rounded-xl border border-border/70 bg-bg/40 p-3 font-mono text-[12px] leading-snug text-muted">
                  {taskPrompt.trim() ? (
                    <pre className="whitespace-pre-wrap">{userPrompt}</pre>
                  ) : (
                    <div className="text-muted">Type a prompt to generate a copyable user message.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="mb-panel p-5">
            <div className="mb-panel-inner flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-fg">Render JSON</div>
                  <div className="text-xs text-muted">
                    Paste your model output (JSON). We’ll validate it against the selected grid + palette.
                  </div>
                </div>
                <button
                  type="button"
                  className="mb-btn mb-btn-primary h-9 px-4 text-xs"
                  onClick={() => renderFromText(modelOutput)}
                >
                  Render
                </button>
              </div>

              <textarea
                className="mb-field min-h-[190px] font-mono text-[12px] leading-snug"
                placeholder='{"version":"1.0","boxes":[],"lines":[],"blocks":[{"x":0,"y":0,"z":0,"type":"stone"}]}'
                value={modelOutput}
                spellCheck={false}
                onChange={(e) => setModelOutput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    renderFromText(modelOutput);
                  }
                }}
              />

              {rendered.kind === "error" && rendered.message ? (
                <div className="mb-subpanel p-3 text-sm text-danger">
                  {rendered.message}
                </div>
              ) : null}

              {rendered.kind === "ready" && rendered.warnings.length ? (
                <div className="mb-subpanel p-3 text-xs text-muted">
                  <div className="font-semibold text-fg">
                    Rendered with {rendered.warnings.length} warning{rendered.warnings.length === 1 ? "" : "s"}.
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-4">
                    {rendered.warnings.slice(0, 4).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {rendered.warnings.length > 4 ? (
                      <li>…and {rendered.warnings.length - 4} more</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              <VoxelViewerCard
                title="Preview"
                subtitle={rendered.kind === "ready" ? `${gridSize}³ • ${palette}` : undefined}
                voxelBuild={rendered.kind === "ready" ? rendered.build : null}
                palette={palette}
                autoRotate
                metrics={
                  rendered.kind === "ready"
                    ? {
                        blockCount: rendered.build?.blocks.length ?? 0,
                        warnings: rendered.warnings,
                        generationTimeMs: 0,
                      }
                    : undefined
                }
              />
            </div>
          </div>

          <div className="mt-4 text-xs text-muted">
            Tip: press <span className="mb-kbd">⌘</span>+<span className="mb-kbd">Enter</span> to render.
          </div>
        </div>
      </div>
    </div>
  );
}
