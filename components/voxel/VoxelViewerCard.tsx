"use client";

import { useCallback, useEffect, useMemo, useState, ReactNode, RefObject } from "react";
import {
  VoxelLoadingHud,
  formatVoxelLoadingMessage,
  type VoxelLoadingProgress,
} from "@/components/voxel/VoxelLoadingHud";
import {
  VoxelViewer,
  type VoxelViewerBuildMetrics,
  type VoxelViewerBuildProgress,
  type VoxelViewerHandle,
} from "@/components/voxel/VoxelViewer";
import { VoxelBuildExportButton } from "@/components/voxel/VoxelBuildExportButton";
import { VoxelEmptyState } from "@/components/voxel/VoxelEmptyState";
import { MAX_BLOCKS_BY_GRID } from "@/lib/ai/limits";
import { getPalette } from "@/lib/blocks/palettes";
import { formatBuildDuration, formatBuildJsonSize } from "@/lib/buildMetrics";
import type { VoxelMeshPayload } from "@/lib/voxel/mesh";
import type { VoxelBuild } from "@/lib/voxel/types";
import {
  toObjectBackedVoxelBuild,
  voxelBuildBlockCount,
  voxelBuildBlocksRef,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { validateVoxelBuild } from "@/lib/voxel/validate";

export function VoxelViewerCard({
  title,
  subtitle,
  voxelBuild,
  expectedBlockCount,
  meshCacheKey,
  getPremeshedPayloadPromise,
  onPremeshedPayloadConsumed,
  gridSize = 256,
  autoRotate = true,
  animateIn,
  onBuildReadyChange,
  onFirstRenderReadyChange,
  onBuildMetrics,
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
  enableBuildExport = false,
  exportLabel,
  exportPrompt,
  exportDisabled,
  exportDisabledReason,
  actions,
  jsonBytes,
  viewerRef,
  skipValidation = false,
  embedded = false,
  useFirstRenderReady = false,
}: {
  title: string;
  subtitle?: ReactNode;
  voxelBuild: unknown | null;
  expectedBlockCount?: number;
  meshCacheKey?: string | null;
  getPremeshedPayloadPromise?: () => Promise<VoxelMeshPayload> | null;
  onPremeshedPayloadConsumed?: (promise: Promise<VoxelMeshPayload>) => void;
  gridSize?: 64 | 256 | 512;
  autoRotate?: boolean;
  animateIn?: boolean;
  useFirstRenderReady?: boolean;
  onBuildReadyChange?: (ready: boolean) => void;
  onFirstRenderReadyChange?: (ready: boolean) => void;
  onBuildMetrics?: (metrics: VoxelViewerBuildMetrics) => void;
  isLoading?: boolean;
  loadingMode?: "overlay" | "silent";
  loadingProgress?: { receivedBlocks: number; totalBlocks: number | null };
  attempt?: number;
  retryReason?: string;
  elapsedMs?: number;
  metrics?: { blockCount: number; warnings: string[]; generationTimeMs?: number; attempts?: number };
  error?: string;
  loadingMessage?: string;
  jsonText?: string;
  debugRawText?: string;
  palette?: "simple" | "advanced";
  viewerSize?: "default" | "arena";
  enableBuildJsonToggle?: boolean;
  enableBuildExport?: boolean;
  exportLabel?: string;
  exportPrompt?: string;
  exportDisabled?: boolean;
  exportDisabledReason?: string;
  actions?: ReactNode;
  jsonBytes?: number | null;
  viewerRef?: RefObject<VoxelViewerHandle | null>;
  skipValidation?: boolean;
  embedded?: boolean;
}) {
  type PlacementProgressState = VoxelLoadingProgress & { stageLabel?: string | null };

  const isLikelyVoxelBuild = (value: unknown): value is RenderableVoxelBuild => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<RenderableVoxelBuild>;
    return candidate.version === "1.0" && Array.isArray(candidate.blocks);
  };

  const rendered = useMemo(() => {
    if (!voxelBuild)
      return {
        build: null as RenderableVoxelBuild | null,
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
    // Validation walks block objects, so a packed build is materialized for it.
    // That only happens when the server has not already validated the payload.
    const validated = validateVoxelBuild(
      isLikelyVoxelBuild(voxelBuild) ? toObjectBackedVoxelBuild(voxelBuild) : voxelBuild,
      {
        gridSize,
        palette: paletteDefs,
        maxBlocks,
      },
    );
    if (!validated.ok) return { build: null, warnings: [], error: validated.error };
    return { build: validated.value.build, warnings: validated.value.warnings, error: null };
  }, [voxelBuild, gridSize, palette, skipValidation]);

  const build = rendered.build;
  const buildBlocksRef = build ? voxelBuildBlocksRef(build) : null;
  const warnings = metrics?.warnings ?? rendered.warnings;
  const blockCount = metrics?.blockCount ?? voxelBuildBlockCount(build);
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
    if (!enableBuildJsonToggle || !voxelBuild) return "";
    try {
      return JSON.stringify(
        isLikelyVoxelBuild(voxelBuild) ? toObjectBackedVoxelBuild(voxelBuild) : voxelBuild,
        null,
        2,
      );
    } catch {
      return "";
    }
  }, [enableBuildJsonToggle, voxelBuild]);

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

  const timing = formatBuildDuration(metrics?.generationTimeMs);
  const jsonSize = formatBuildJsonSize(jsonBytes);

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
      ? "relative h-[48svh] min-h-[260px] max-h-[440px] w-full sm:h-[48vh] sm:min-h-[280px] sm:max-h-[450px] md:h-[52vh] md:min-h-[320px] md:max-h-[420px] lg:h-[56vh] lg:max-h-[480px] xl:h-[60vh] xl:max-h-[520px]"
      : "relative h-[300px] w-full sm:h-[360px] md:h-[420px] lg:h-[480px] xl:h-[520px]";
  const loadingLabel =
    retryReason || (attempt && attempt > 1)
      ? "Trying again…"
      : loadingMessage?.trim() ||
    (attempt === 0
      ? "Queued…"
      : isThinking
        ? "Thinking…"
        : debugRawText
          ? "Streaming…"
          : "Generating…");
  const showLoadingOverlay = loadingMode !== "silent";
  const [firstRenderReady, setFirstRenderReady] = useState(false);
  const placementLoading = Boolean(
    showBuildView &&
      build &&
      !combinedError &&
      !(useFirstRenderReady ? firstRenderReady : viewerReady),
  );
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
            totalBlocks: voxelBuildBlockCount(build),
          }
        : null);
  const hudLabel = isLoading
    ? loadingLabel
    : formatVoxelLoadingMessage(placementProgress?.stageLabel ?? "Placing blocks", placementProgress);
  const showLoadingHud = Boolean((isLoading || placementLoading) && showBuildView && showLoadingOverlay);

  useEffect(() => {
    setViewerReady(false);
    setFirstRenderReady(false);
    setPlacementProgress(null);
    setPlacementError(null);
  }, [buildBlocksRef, palette]);

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

  const handleFirstRenderReadyChange = useCallback(
    (ready: boolean) => {
      setFirstRenderReady(ready);
      if (ready) {
        setPlacementProgress(null);
        setPlacementError(null);
      }
      onFirstRenderReadyChange?.(ready);
    },
    [onFirstRenderReadyChange],
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
      setFirstRenderReady(false);
    }
  }, []);

  return (
    <div className={embedded ? "overflow-hidden bg-card/25" : "mb-panel"}>
      <div className="mb-panel-inner">
        <div className="border-b border-border/70 bg-bg/10 px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <div className="min-w-0 truncate font-display text-lg font-semibold tracking-tight text-fg sm:text-xl">
                  {title}
                </div>
                {subtitle ? (
                  <div className="min-w-0 truncate text-xs text-muted sm:text-sm">{subtitle}</div>
                ) : null}
              </div>
              {build ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-y-1 font-mono text-[11px] tabular-nums text-muted sm:text-xs [&>span+span]:before:mx-2 [&>span+span]:before:text-border [&>span+span]:before:content-['·']">
                  <span className="whitespace-nowrap">{blockCount.toLocaleString()} blocks</span>
                  {jsonSize ? <span className="whitespace-nowrap">{jsonSize} JSON</span> : null}
                  {timing ? <span className="whitespace-nowrap">{timing}</span> : null}
                  {metrics?.attempts ? (
                    <span className="whitespace-nowrap">
                      {metrics.attempts} attempt{metrics.attempts === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {warnings.length ? (
                    <span className="whitespace-nowrap">
                      {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
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
              {enableBuildExport || actions ? (
                <div className="flex items-center gap-1.5">
                  {enableBuildExport ? (
                    <VoxelBuildExportButton
                      build={build}
                      palette={palette}
                      fileLabel={exportLabel ?? title}
                      promptText={exportPrompt}
                      disabled={exportDisabled}
                      disabledReason={exportDisabledReason}
                    />
                  ) : null}
                  {actions}
                </div>
              ) : null}
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
              getPremeshedPayloadPromise={getPremeshedPayloadPromise}
              onPremeshedPayloadConsumed={onPremeshedPayloadConsumed}
              autoRotate={autoRotate}
              // During progressive hydration, avoid restarting reveal animation on each chunk update.
              animateIn={Boolean(animateIn && !isLoading)}
              onBuildReadyChange={handleBuildReadyChange}
              onFirstRenderReadyChange={handleFirstRenderReadyChange}
              onBuildMetrics={onBuildMetrics}
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
                {retryReason ? (
                  <details className="w-full max-w-xs text-left text-xs text-muted">
                    <summary className="mx-auto flex w-fit cursor-pointer list-none items-center gap-1.5 rounded px-2 py-1 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px]">i</span>
                      Details
                    </summary>
                    <p className="mt-2 break-words whitespace-pre-wrap rounded-md border border-border/70 bg-bg/45 p-3 leading-relaxed">
                      {retryReason}
                    </p>
                  </details>
                ) : null}
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

          {showBuildView && !build && !combinedError ? (
            <VoxelEmptyState />
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
