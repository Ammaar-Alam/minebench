"use client";

import { useCallback, useEffect, useMemo, useState, ReactNode, RefObject } from "react";
import {
  VoxelLoadingHud,
  formatVoxelLoadingMessage,
  type VoxelLoadingProgress,
} from "@/components/voxel/VoxelLoadingHud";
import {
  VoxelViewer,
  type VoxelViewerBuildProgress,
  type VoxelViewerHandle,
} from "@/components/voxel/VoxelViewer";
import { MAX_BLOCKS_BY_GRID } from "@/lib/ai/limits";
import { getPalette } from "@/lib/blocks/palettes";
import type { VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";

export function VoxelViewerCard({
  title,
  subtitle,
  voxelBuild,
  expectedBlockCount,
  meshCacheKey,
  gridSize = 256,
  autoRotate = true,
  animateIn,
  onBuildReadyChange,
  isLoading,
  loadingMode = "overlay",
  loadingProgress,
  attempt,
  retryReason,
  elapsedMs,
  metrics,
  error,
  loadingMessage,
  jsonText,
  debugRawText,
  palette = "simple",
  viewerSize = "default",
  enableBuildJsonToggle = false,
  actions,
  viewerRef,
  skipValidation = false,
}: {
  title: string;
  subtitle?: ReactNode;
  voxelBuild: unknown | null;
  expectedBlockCount?: number;
  meshCacheKey?: string | null;
  gridSize?: 64 | 256 | 512;
  autoRotate?: boolean;
  animateIn?: boolean;
  onBuildReadyChange?: (ready: boolean) => void;
  isLoading?: boolean;
  loadingMode?: "overlay" | "silent";
  loadingProgress?: { receivedBlocks: number; totalBlocks: number | null };
  attempt?: number;
  retryReason?: string;
  elapsedMs?: number;
  metrics?: { blockCount: number; warnings: string[]; generationTimeMs?: number };
  error?: string;
  loadingMessage?: string;
  jsonText?: string;
  debugRawText?: string;
  palette?: "simple" | "advanced";
  viewerSize?: "default" | "arena";
  enableBuildJsonToggle?: boolean;
  actions?: ReactNode;
  viewerRef?: RefObject<VoxelViewerHandle | null>;
  skipValidation?: boolean;
}) {
  type PlacementProgressState = VoxelLoadingProgress & { stageLabel?: string | null };

  const isLikelyVoxelBuild = (value: unknown): value is VoxelBuild => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<VoxelBuild>;
    return candidate.version === "1.0" && Array.isArray(candidate.blocks);
  };

  const rendered = useMemo(() => {
    if (!voxelBuild)
      return {
        build: null as VoxelBuild | null,
        warnings: [] as string[],
        error: null as string | null,
      };
    if (skipValidation && isLikelyVoxelBuild(voxelBuild)) {
      return {
        build: voxelBuild,
        warnings: [] as string[],
        error: null as string | null,
      };
    }
    const paletteDefs = getPalette(palette);
    const maxBlocks = MAX_BLOCKS_BY_GRID[gridSize] ?? MAX_BLOCKS_BY_GRID[256];
    const validated = validateVoxelBuild(voxelBuild, {
      gridSize,
      palette: paletteDefs,
      maxBlocks,
    });
    if (!validated.ok) return { build: null, warnings: [], error: validated.error };
    return { build: validated.value.build, warnings: validated.value.warnings, error: null };
  }, [voxelBuild, gridSize, palette, skipValidation]);

  const build = rendered.build;
  const warnings = metrics?.warnings ?? rendered.warnings;
  const blockCount = metrics?.blockCount ?? build?.blocks.length ?? 0;
  const isThinking = Boolean(isLoading && attempt && attempt > 0 && !debugRawText);
  const [preferredView, setPreferredView] = useState<"build" | "json">("build");
  const [showRawBuildJson, setShowRawBuildJson] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [placementProgress, setPlacementProgress] = useState<PlacementProgressState | null>(null);
  const [placementError, setPlacementError] = useState<string | null>(null);
  const combinedError = error ?? placementError ?? rendered.error ?? undefined;

  const modelOutputText = useMemo(() => {
    const explicitText =
      (typeof jsonText === "string" ? jsonText : undefined) ??
      (typeof debugRawText === "string" ? debugRawText : undefined);
    const trimmed = explicitText?.trim();
    if (trimmed) return explicitText ?? "";
    return "";
  }, [jsonText, debugRawText]);

  const buildJsonText = useMemo(() => {
    if (!voxelBuild) return "";
    try {
      return JSON.stringify(voxelBuild, null, 2);
    } catch {
      return "";
    }
  }, [voxelBuild]);

  const hasBuildView = Boolean(build);
  const hasModelOutputJson = modelOutputText.trim().length > 0;
  const hasRawBuildJson = buildJsonText.trim().length > 0;
  const hasJsonView = hasModelOutputJson || hasRawBuildJson;
  const showViewToggle = enableBuildJsonToggle;
  const activeView: "build" | "json" = showViewToggle ? preferredView : "build";
  const showBuildView = activeView === "build";
  const showJsonView = activeView === "json";
  const visibleJsonText = showRawBuildJson
    ? buildJsonText || modelOutputText
    : modelOutputText || buildJsonText;

  const timing = useMemo(() => {
    const ms = metrics?.generationTimeMs;
    if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
    if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms)}ms`;
  }, [metrics?.generationTimeMs]);

  const elapsed = useMemo(() => {
    const ms = elapsedMs;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${seconds}s`;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }, [elapsedMs]);

  const viewerHeightClass =
    viewerSize === "arena"
      ? "relative h-[42svh] min-h-[250px] max-h-[360px] w-full sm:h-[44vh] sm:min-h-[260px] sm:max-h-[360px] md:h-[52vh] md:min-h-[320px] md:max-h-[420px] lg:h-[56vh] lg:max-h-[480px] xl:h-[60vh] xl:max-h-[520px]"
      : "relative h-[300px] w-full sm:h-[360px] md:h-[420px] lg:h-[480px] xl:h-[520px]";
  const loadingLabel =
    loadingMessage?.trim() ||
    (attempt === 0
      ? "Queued…"
      : isThinking
        ? "Thinking…"
        : debugRawText
          ? "Streaming…"
          : "Generating…");
  const showLoadingOverlay = loadingMode !== "silent";
  const placementLoading = Boolean(showBuildView && build && !combinedError && !viewerReady);
  const hudProgress = isLoading
    ? loadingProgress
      ? {
          receivedBlocks: loadingProgress.receivedBlocks,
          totalBlocks: loadingProgress.totalBlocks,
        }
      : null
    : placementProgress ??
      (placementLoading
        ? {
            receivedBlocks: 0,
            totalBlocks: build?.blocks.length ?? null,
          }
        : null);
  const hudLabel = isLoading
    ? loadingLabel
    : formatVoxelLoadingMessage(placementProgress?.stageLabel ?? "Placing blocks", placementProgress);
  const showLoadingHud = Boolean((isLoading || placementLoading) && showBuildView && showLoadingOverlay);

  useEffect(() => {
    setViewerReady(false);
    setPlacementProgress(null);
    setPlacementError(null);
  }, [build?.blocks, palette]);

  const handleBuildReadyChange = useCallback(
    (ready: boolean) => {
      setViewerReady(ready);
      if (ready) {
        setPlacementProgress(null);
        setPlacementError(null);
      }
      onBuildReadyChange?.(ready);
    },
    [onBuildReadyChange],
  );

  const handleBuildProgressChange = useCallback(
    (progress: VoxelViewerBuildProgress | null) => {
      if (!progress) {
        setPlacementProgress(null);
        return;
      }
      setPlacementProgress({
        receivedBlocks: Math.max(0, Math.floor(progress.processedBlocks)),
        totalBlocks: Math.max(1, Math.floor(progress.totalBlocks)),
        stageLabel: progress.stageLabel ?? null,
      });
    },
    [],
  );

  const handleBuildErrorChange = useCallback((message: string | null) => {
    setPlacementError(message);
    if (message) {
      setPlacementProgress(null);
      setViewerReady(false);
    }
  }, []);

  return (
    <div className="mb-panel">
      <div className="mb-panel-inner">
        <div className="border-b border-border bg-bg/10 px-3 py-2 sm:px-4 sm:py-2.5">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <div className="font-display text-base font-semibold tracking-tight text-fg">
                  {title}
                </div>
                {subtitle ? (
                  <div className="min-h-[1.1rem] text-[12px] sm:text-[13px]">{subtitle}</div>
                ) : null}
              </div>
              {build ? (
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted sm:hidden">
                  <span className="font-mono">
                    {blockCount.toLocaleString()} blocks
                  </span>
                  {timing ? (
                    <span className="font-mono text-muted2">
                      {timing}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-2 sm:shrink-0 sm:justify-end sm:gap-2">
              {showViewToggle ? (
                <div className="relative flex w-[182px] rounded-full bg-bg/55 p-1 ring-1 ring-border/80 sm:w-[210px]">
                  <div className="pointer-events-none absolute inset-1 rounded-full">
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 rounded-full border border-accent/55 bg-accent/24 shadow-[0_8px_20px_-14px_rgba(61,229,204,0.85)] transition-transform duration-300 ease-out"
                      style={{
                        width: "50%",
                        transform: activeView === "json" ? "translateX(100%)" : "translateX(0%)",
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreferredView("build")}
                    className={`relative z-10 h-9 flex-1 rounded-full px-3 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
                      activeView === "build" ? "text-fg" : "text-muted hover:text-fg"
                    }`}
                  >
                    Build
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreferredView("json")}
                    className={`relative z-10 h-9 flex-1 rounded-full px-3 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
                      activeView === "json" ? "text-fg" : "text-muted hover:text-fg"
                    }`}
                  >
                    JSON
                  </button>
                </div>
              ) : null}
              {actions ? <div className="flex items-center">{actions}</div> : null}
              <div className="hidden text-right text-[11px] text-muted sm:block sm:text-xs">
                {build ? (
                  <div className="items-center gap-2 font-mono sm:flex">
                    <span>{blockCount.toLocaleString()} blocks</span>
                    {timing ? <span>• {timing}</span> : null}
                    {warnings.length ? (
                      <span>
                        • {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className={viewerHeightClass}>
          {showBuildView ? (
            <VoxelViewer
              ref={viewerRef}
              voxelBuild={build}
              palette={palette}
              expectedBlockCount={expectedBlockCount}
              meshCacheKey={meshCacheKey}
              autoRotate={autoRotate}
              // During progressive hydration, avoid restarting reveal animation on each chunk update.
              animateIn={Boolean(animateIn && !isLoading)}
              onBuildReadyChange={handleBuildReadyChange}
              onBuildProgressChange={handleBuildProgressChange}
              onBuildErrorChange={handleBuildErrorChange}
            />
          ) : null}

          {showJsonView ? (
            <div className="absolute inset-0 overflow-hidden bg-bg/30">
              <div className="absolute right-5 top-3 z-20 flex items-center gap-2 rounded-full border border-border/70 bg-bg/65 px-2.5 py-1 text-[11px] text-muted backdrop-blur-sm">
                <label className="inline-flex cursor-pointer select-none items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showRawBuildJson}
                    onChange={(e) => setShowRawBuildJson(e.target.checked)}
                    disabled={!hasRawBuildJson}
                    className="h-3.5 w-3.5 rounded border-border bg-bg text-accent disabled:cursor-not-allowed disabled:opacity-45"
                  />
                  <span className={hasRawBuildJson ? "text-fg/90" : "text-muted/70"}>Raw JSON</span>
                </label>
              </div>
              <div className="absolute inset-0 overflow-auto px-3 py-3 sm:px-4 sm:py-4">
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg/90">
                  {visibleJsonText}
                </pre>
              </div>
            </div>
          ) : null}

          {showBuildView && build ? (
            <div className="pointer-events-none absolute bottom-[3.5rem] left-2.5 flex gap-2 sm:bottom-3 sm:left-3">
              <span className="mb-badge px-2 py-0.5 text-[10px] sm:px-3 sm:py-1.5 sm:text-xs">
                <span className="sm:hidden">Drag to spin • Pinch to zoom</span>
                <span className="hidden sm:inline">
                  Drag to rotate • <span className="mb-kbd">Ctrl</span>+drag to pan • Scroll to zoom
                </span>
              </span>
            </div>
          ) : null}

          {showLoadingHud ? (
            <VoxelLoadingHud
              label={hudLabel}
              progress={hudProgress}
              elapsed={elapsed}
              attempt={attempt}
              retryReason={retryReason}
            />
          ) : null}

          {isLoading && showJsonView && showLoadingOverlay ? (
            <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1 rounded-md border border-border/70 bg-bg/60 px-3 py-2 text-xs text-muted backdrop-blur-sm">
              <div>{loadingLabel}</div>
              {elapsed ? <div className="font-mono">{elapsed}</div> : null}
              {visibleJsonText ? (
                <div className="font-mono">{visibleJsonText.length.toLocaleString()} chars</div>
              ) : null}
              {attempt && attempt > 1 ? <div className="font-mono">retry {attempt}</div> : null}
            </div>
          ) : null}

          {combinedError && showBuildView ? (
            <div className="absolute inset-0 flex items-center justify-center bg-bg/75 px-4 text-center backdrop-blur-[2px]">
              <div className="flex w-full max-w-[94%] flex-col items-center gap-2.5 sm:max-w-sm">
                <div
                  aria-hidden="true"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-danger/15 text-danger ring-1 ring-danger/30"
                >
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 8v4" />
                    <path d="M12 16h.01" />
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                </div>
                <div className="text-sm font-medium text-fg">Couldn&apos;t render this build</div>
                <div className="max-w-full break-words text-xs leading-relaxed text-muted">
                  {combinedError}
                </div>
                {hasJsonView && showViewToggle ? (
                  <div className="text-[11px] text-muted/75">
                    Switch to JSON to inspect the raw output.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {combinedError && showJsonView ? (
            <div className="absolute left-3 right-3 top-14 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger backdrop-blur-sm">
              <svg
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
                <circle cx="12" cy="12" r="9" />
              </svg>
              <span className="min-w-0 break-words">{combinedError}</span>
            </div>
          ) : null}

          {showBuildView && !build && !isLoading && !combinedError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/20 text-sm text-muted">
              <div
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-border/70 text-muted/60"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <path d="M3.3 7l8.7 5 8.7-5" />
                  <path d="M12 22v-9" />
                </svg>
              </div>
              <span className="text-xs text-muted/80">No build yet</span>
            </div>
          ) : null}

          {showJsonView && !hasJsonView && !isLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/20 text-sm text-muted">
              <div
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-border/70 text-muted/60"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 13V9a2 2 0 0 0-2-2H6" />
                  <path d="M6 17h2a2 2 0 0 0 2-2v-2" />
                  <path d="M14 13V9a2 2 0 0 1 2-2h2" />
                  <path d="M18 17h-2a2 2 0 0 1-2-2v-2" />
                </svg>
              </div>
              <span className="text-xs text-muted/80">No JSON yet</span>
            </div>
          ) : null}
        </div>

        {warnings.length ? (
          <details className="border-t border-border bg-bg/10 px-3 py-2.5 text-xs text-muted sm:px-4 sm:py-3">
            <summary className="cursor-pointer select-none font-semibold text-fg">
              Warnings ({warnings.length})
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}
