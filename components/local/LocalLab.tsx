"use client";

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { SandboxGifExportButton, type SandboxGifExportTarget } from "@/components/sandbox/SandboxGifExportButton";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompts";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { getPalette } from "@/lib/blocks/palettes";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";

type Palette = "simple" | "advanced";
type GridSize = 64 | 256 | 512;

const MAX_BLOCKS_BY_GRID: Record<GridSize, number> = {
  64: Math.floor(64 ** 3 * 0.95),
  256: Math.floor(256 ** 3 * 0.95),
  512: Math.floor(512 ** 3 * 0.95),
};

const MIN_BLOCKS_BY_GRID: Record<GridSize, number> = {
  64: 200,
  256: 500,
  512: 800,
};

type LocalParseWorkerRequest =
  | {
      type: "parse";
      requestId: number;
      rawText: string;
      gridSize: GridSize;
      palette: Palette;
      maxBlocksByGrid: Record<GridSize, number>;
    }
  | {
      type: "cancel";
      requestId?: number;
    };

type LocalParseWorkerResponse =
  | {
      type: "progress";
      requestId: number;
      deltaBlocks: VoxelBuild["blocks"];
      receivedBlocks: number;
      totalBlocks: number | null;
    }
  | {
      type: "complete";
      requestId: number;
      voxelBuild: VoxelBuild;
      warnings: string[];
      receivedBlocks: number;
      totalBlocks: number | null;
      source: "build-json" | "tool-call";
      resolved: {
        gridSize: GridSize;
        palette: Palette;
      };
    }
  | {
      type: "error";
      requestId: number;
      message: string;
    };

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

const LARGE_PASTE_CHAR_THRESHOLD = 2_500_000;

function formatCompactCount(value: number): string {
  return value.toLocaleString();
}

function formatApproxMbFromChars(chars: number): string {
  const mb = chars / 1_000_000;
  if (mb >= 100) return `${Math.round(mb)}MB`;
  if (mb >= 10) return `${mb.toFixed(1)}MB`;
  return `${mb.toFixed(2)}MB`;
}

function trimOuterWhitespace(text: string): string {
  if (!text) return "";
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
  if (start === 0 && end === text.length) return text;
  return text.slice(start, end);
}

function CopyButton({
  label,
  text,
  disabled,
  tone = "ghost",
  icon,
  className,
}: {
  label: string;
  text: string;
  disabled?: boolean;
  tone?: "ghost" | "primary";
  icon?: ReactNode;
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
      className={cx(
        "mb-btn h-8 rounded-full px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs",
        tone === "primary" ? "mb-btn-primary" : "mb-btn-ghost",
        className,
      )}
      disabled={disabled}
      onClick={copy}
    >
      <span className="inline-flex items-center gap-1.5">
        {icon}
        <span>{status === "copied" ? "Copied" : status === "error" ? "Copy failed" : label}</span>
      </span>
    </button>
  );
}

function SegmentedControl({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  const safeCount = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const segmentWidth = `calc((100% - 0.5rem) / ${safeCount})`;
  const segmentTranslate = `${activeIndex * 100}%`;

  return (
    <div className={cx("relative flex rounded-full bg-bg/55 p-1 ring-1 ring-border/80", className)}>
      <div className="pointer-events-none absolute inset-1 rounded-full">
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-full border border-accent/55 bg-accent/24 shadow-[0_8px_20px_-14px_rgba(61,229,204,0.85)] transition-transform duration-300 ease-out"
          style={{
            width: segmentWidth,
            transform: `translateX(${segmentTranslate})`,
          }}
        />
      </div>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            className={cx(
              "relative z-10 h-7 flex-1 rounded-full px-3 text-xs font-medium transition-colors sm:h-8",
              active ? "text-fg" : "text-muted hover:text-fg",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function LocalLab() {
  const [gridSize, setGridSize] = useState<GridSize>(256);
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
    "A warm wooden cabin beside a pond, with a stone chimney, a small dock, and a few trees.",
  );
  const userPrompt = useMemo(() => buildUserPrompt(taskPrompt.trim()), [taskPrompt]);

  const combinedPrompt = useMemo(() => {
    return `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`;
  }, [systemPrompt, userPrompt]);

  const modelOutputRef = useRef<HTMLTextAreaElement | null>(null);
  const bufferedOutputRef = useRef<string | null>(null);
  const [inputStats, setInputStats] = useState<{ mode: "empty" | "editor" | "buffered"; chars: number }>({
    mode: "empty",
    chars: 0,
  });
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{
    kind: "idle" | "loading" | "ready" | "error";
    build: VoxelBuild | null;
    warnings: string[];
    progress?: {
      receivedBlocks: number;
      totalBlocks: number | null;
    };
    message?: string;
  }>({ kind: "idle", build: null, warnings: [] });
  const previewViewerRef = useRef<VoxelViewerHandle | null>(null);
  const parseWorkerRef = useRef<Worker | null>(null);
  const parseRequestIdRef = useRef(0);
  const streamedBlocksRef = useRef<VoxelBuild["blocks"]>([]);
  const gridSizeRef = useRef<GridSize>(gridSize);
  const paletteRef = useRef<Palette>(palette);

  useEffect(() => {
    gridSizeRef.current = gridSize;
  }, [gridSize]);

  useEffect(() => {
    paletteRef.current = palette;
  }, [palette]);

  useEffect(() => {
    const worker = new Worker(new URL("./localBuildParse.worker.ts", import.meta.url));
    parseWorkerRef.current = worker;

    const onMessage = (event: MessageEvent<LocalParseWorkerResponse>) => {
      const message = event.data;
      if (!message) return;

      if (message.requestId !== parseRequestIdRef.current) return;

      if (message.type === "progress") {
        if (message.deltaBlocks.length > 0) {
          streamedBlocksRef.current.push(...message.deltaBlocks);
        }

        setRendered({
          kind: "loading",
          build: {
            version: "1.0",
            blocks: streamedBlocksRef.current,
          },
          warnings: [],
          progress: {
            receivedBlocks: message.receivedBlocks,
            totalBlocks: message.totalBlocks,
          },
        });
        return;
      }

      if (message.type === "complete") {
        if (message.resolved.gridSize !== gridSizeRef.current) {
          setGridSize(message.resolved.gridSize);
        }
        if (message.resolved.palette !== paletteRef.current) {
          setPalette(message.resolved.palette);
        }
        if (message.source === "tool-call") {
          const switchedSettings =
            message.resolved.gridSize !== gridSizeRef.current || message.resolved.palette !== paletteRef.current;
          setStatusNote(
            switchedSettings
              ? `Converted tool output and matched settings to ${message.resolved.gridSize} / ${message.resolved.palette}.`
              : "Converted tool output and rendered.",
          );
        } else {
          setStatusNote(null);
        }

        setRendered({
          kind: "ready",
          build: message.voxelBuild,
          warnings: message.warnings,
          progress: {
            receivedBlocks: message.receivedBlocks,
            totalBlocks: message.totalBlocks,
          },
        });
        return;
      }

      if (message.type === "error") {
        setStatusNote(null);
        setRendered({
          kind: "error",
          build: null,
          warnings: [],
          message: message.message,
        });
      }
    };

    worker.addEventListener("message", onMessage);

    return () => {
      worker.removeEventListener("message", onMessage);
      try {
        worker.postMessage({ type: "cancel" } satisfies LocalParseWorkerRequest);
      } catch {
        // ignore
      }
      worker.terminate();
      if (parseWorkerRef.current === worker) parseWorkerRef.current = null;
    };
  }, []);

  const previewExportTargets: SandboxGifExportTarget[] = useMemo(() => {
    if (rendered.kind !== "ready" || !rendered.build) return [];
    return [
      {
        viewerRef: previewViewerRef,
        modelName: "Local Preview",
        company: "MineBench",
        blockCount: rendered.build.blocks.length,
      },
    ];
  }, [rendered]);

  const hasInput = inputStats.mode === "buffered" || inputStats.chars > 0;

  function readActiveInputText() {
    if (typeof bufferedOutputRef.current === "string") return bufferedOutputRef.current;
    return modelOutputRef.current?.value ?? "";
  }

  function clearModelInput() {
    bufferedOutputRef.current = null;
    if (modelOutputRef.current) modelOutputRef.current.value = "";
    setInputStats({ mode: "empty", chars: 0 });
    setStatusNote(null);
  }

  function renderFromText(text: string) {
    const trimmed = trimOuterWhitespace(text);
    if (!trimmed) {
      setStatusNote(null);
      setRendered({
        kind: "error",
        build: null,
        warnings: [],
        message: "Paste a JSON object first.",
      });
      return;
    }

    const fallbackSync = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(trimmed) as unknown;
      } catch {
        json = extractBestVoxelBuildJson(trimmed);
      }

      if (!json) {
        setStatusNote(null);
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
        setStatusNote(null);
        setRendered({ kind: "error", build: null, warnings: [], message: validated.error });
        return;
      }

      setStatusNote(null);
      setRendered({
        kind: "ready",
        build: validated.value.build,
        warnings: validated.value.warnings,
        progress: {
          receivedBlocks: validated.value.build.blocks.length,
          totalBlocks: validated.value.build.blocks.length,
        },
      });
    };

    const worker = parseWorkerRef.current;
    if (!worker) {
      fallbackSync();
      return;
    }

    setStatusNote(null);
    const currentRequestId = parseRequestIdRef.current;
    if (currentRequestId > 0) {
      try {
        worker.postMessage({ type: "cancel", requestId: currentRequestId } satisfies LocalParseWorkerRequest);
      } catch {
        // ignore
      }
    }

    const requestId = ++parseRequestIdRef.current;
    streamedBlocksRef.current = [];
    setRendered({
      kind: "loading",
      build: null,
      warnings: [],
      progress: { receivedBlocks: 0, totalBlocks: null },
    });

    try {
      worker.postMessage({
        type: "parse",
        requestId,
        rawText: trimmed,
        gridSize,
        palette,
        maxBlocksByGrid: MAX_BLOCKS_BY_GRID,
      } satisfies LocalParseWorkerRequest);
    } catch {
      fallbackSync();
    }
  }

  function renderFromInput() {
    renderFromText(readActiveInputText());
  }

  const loadingMessage =
    rendered.kind === "loading"
      ? (() => {
          const total = rendered.progress?.totalBlocks ?? null;
          const received = rendered.progress?.receivedBlocks ?? 0;
          if (!total || total <= 0) {
            if (received > 0) return `Retrieving build ${received.toLocaleString()} blocks`;
            return "Retrieving build...";
          }
          const pct = Math.max(1, Math.min(99, Math.round((received / total) * 100)));
          return `Retrieving build ${pct}%`;
        })()
      : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-panel p-4 sm:p-5">
        <div className="mb-panel-inner flex flex-col gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="font-display text-[1.85rem] font-semibold tracking-tight text-fg sm:text-[2.1rem]">
                Test models locally
              </div>
              <div className="mt-1 text-sm text-muted">
                Test out changing the system prompt, generate a custom build, then paste the JSON to render it.
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <SegmentedControl
                value={String(gridSize)}
                onChange={(value) => setGridSize(Number(value) as GridSize)}
                options={[
                  { value: "64", label: "64^3" },
                  { value: "256", label: "256^3" },
                  { value: "512", label: "512^3" },
                ]}
                className="min-w-[220px]"
              />
              <SegmentedControl
                value={palette}
                onChange={(value) => setPalette(value as Palette)}
                options={[
                  { value: "simple", label: "Simple" },
                  { value: "advanced", label: "Advanced" },
                ]}
                className="min-w-[190px]"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="mb-panel h-full p-4">
          <div className="mb-panel-inner h-full">
            <div className="flex h-full flex-col rounded-2xl border border-border/70 bg-bg/20">
              <div className="p-3 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg">System prompt</div>
                    <div className="text-xs text-muted">
                      Here&apos;s the default system prompt the official benchmark uses. Feel free to play around with
                      it.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <CopyButton
                      label="Copy system"
                      text={systemPrompt}
                      tone="ghost"
                      icon={
                        <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                          <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                          <rect x="5" y="5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                      }
                    />
                    <button
                      type="button"
                      className="mb-btn mb-btn-ghost h-8 w-8 rounded-full p-0 text-muted sm:h-9 sm:w-9"
                      disabled={systemIsDefault}
                      onClick={() => {
                        setSystemPrompt(defaultSystem);
                        setSystemIsDefault(true);
                      }}
                      title="Reset system prompt"
                    >
                      <svg
                        aria-hidden="true"
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      >
                        <path d="M20 12a8 8 0 1 1-2.34-5.66" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M20 4v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>

                <textarea
                  className="mb-field mt-3 min-h-[178px] font-mono text-[12px] leading-snug"
                  value={systemPrompt}
                  spellCheck={false}
                  onChange={(e) => {
                    setSystemIsDefault(false);
                    setSystemPrompt(e.target.value);
                  }}
                />
              </div>

              <div className="border-t border-border/70" />

              <div className="p-3 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg">User prompt</div>
                    <div className="text-xs text-muted">The actual object you want the model to build.</div>
                  </div>
                  <CopyButton
                    label="Copy both"
                    text={combinedPrompt}
                    disabled={!taskPrompt.trim()}
                    tone="primary"
                    icon={
                      <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                        <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                        <rect x="5" y="5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                      </svg>
                    }
                  />
                </div>

                <input
                  className="mb-field mt-3 h-10"
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  placeholder="Describe the build..."
                />
                <div className="mt-2 min-h-[142px] rounded-xl border border-border/70 bg-bg/40 p-3 font-mono text-[12px] leading-snug text-muted">
                  {taskPrompt.trim() ? (
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap">{userPrompt}</pre>
                  ) : (
                    <div className="text-muted">Add a task prompt to generate the user message.</div>
                  )}
                </div>
              </div>

              <div className="border-t border-border/70" />

              <div className="p-3 sm:p-4">
                <div className="text-sm font-semibold text-fg">
                  Test Local Models or Try Directly On a Website (e.g. ChatGPT or Claude)
                </div>
                <div className="mt-1 text-xs leading-relaxed text-muted">
                  Press the Copy Both button to copy the system prompt with your user prompt.
                </div>
                <div className="mt-2 text-xs leading-relaxed text-muted">
                  Note: If you&apos;re generating the build through a site like chatgpt.com directly, add one final line
                  asking for a downloadable JSON file or artifact attachment instead of raw JSON text. Otherwise the
                  model will output just raw text and hit it&apos;s output limit.
                </div>
                <div className="mt-2 rounded-lg border border-border/70 bg-bg/45 p-2 font-mono text-[11px] leading-snug text-muted">
                  Return only the final voxel object as a JSON file/artifact attachment.
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mb-panel p-4">
          <div className="mb-panel-inner flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">Render JSON</div>
                <div className="text-xs text-muted">Paste model output and render with Cmd/Ctrl+Enter.</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="mb-btn mb-btn-ghost h-8 rounded-full px-3 text-xs sm:h-9 sm:px-4"
                  onClick={clearModelInput}
                  disabled={!hasInput}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="mb-btn mb-btn-primary h-8 rounded-full px-3 text-xs sm:h-9 sm:px-4"
                  onClick={renderFromInput}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none">
                      <path d="m6 4 12 8-12 8V4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    </svg>
                    <span>Render</span>
                  </span>
                </button>
              </div>
            </div>

            <textarea
              ref={modelOutputRef}
              className="mb-field min-h-[150px] font-mono text-[12px] leading-snug"
              placeholder='{"version":"1.0","boxes":[],"lines":[],"blocks":[{"x":0,"y":0,"z":0,"type":"stone"}]}'
              spellCheck={false}
              onPaste={(e) => {
                const pasted = e.clipboardData?.getData("text") ?? "";
                if (!pasted || pasted.length < LARGE_PASTE_CHAR_THRESHOLD) return;

                e.preventDefault();
                bufferedOutputRef.current = pasted;
                if (modelOutputRef.current) modelOutputRef.current.value = "";
                setInputStats({ mode: "buffered", chars: pasted.length });
                setStatusNote(
                  `Large paste buffered (${formatCompactCount(pasted.length)} chars, ~${formatApproxMbFromChars(
                    pasted.length,
                  )}).`,
                );
              }}
              onChange={(e) => {
                if (bufferedOutputRef.current != null) {
                  bufferedOutputRef.current = null;
                }
                const chars = e.target.value.length;
                setInputStats({ mode: chars > 0 ? "editor" : "empty", chars });
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  renderFromInput();
                }
              }}
            />

            {inputStats.mode !== "empty" ? (
              <div className="text-[11px] text-muted">
                {inputStats.mode === "buffered" ? "Buffered paste" : "Editor input"}:{" "}
                {formatCompactCount(inputStats.chars)} chars (~{formatApproxMbFromChars(inputStats.chars)})
              </div>
            ) : null}

            {statusNote ? <div className="mb-subpanel p-3 text-xs text-muted">{statusNote}</div> : null}

            {rendered.kind === "error" && rendered.message ? (
              <div className="mb-subpanel p-3 text-sm text-danger">{rendered.message}</div>
            ) : null}

            {rendered.kind === "ready" && rendered.warnings.length ? (
              <div className="mb-subpanel p-3 text-xs text-muted">
                <div className="font-semibold text-fg">
                  Rendered with {rendered.warnings.length} warning
                  {rendered.warnings.length === 1 ? "" : "s"}.
                </div>
                <ul className="mt-1.5 list-disc space-y-1 pl-4">
                  {rendered.warnings.slice(0, 4).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {rendered.warnings.length > 4 ? <li>...and {rendered.warnings.length - 4} more</li> : null}
                </ul>
              </div>
            ) : null}

            <VoxelViewerCard
              title="Preview"
              voxelBuild={
                rendered.kind === "ready" || rendered.kind === "loading" ? rendered.build : null
              }
              gridSize={gridSize}
              palette={palette}
              autoRotate
              isLoading={rendered.kind === "loading"}
              loadingMessage={loadingMessage}
              skipValidation={rendered.kind === "loading"}
              viewerRef={previewViewerRef}
              actions={
                <SandboxGifExportButton
                  targets={previewExportTargets}
                  promptText={taskPrompt}
                  label="Export GIF"
                  iconOnly
                />
              }
              metrics={
                rendered.kind === "ready" || rendered.kind === "loading"
                  ? {
                      blockCount:
                        rendered.progress?.receivedBlocks ?? rendered.build?.blocks.length ?? 0,
                      warnings: rendered.warnings,
                      generationTimeMs: 0,
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
