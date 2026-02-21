"use client";

import { useMemo, useState, ReactNode, RefObject } from "react";
import { VoxelViewer, type VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { getPalette } from "@/lib/blocks/palettes";
import type { VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";

const VIEWER_MAX_BLOCKS_BY_GRID: Record<64 | 256 | 512, number> = {
  64: 262_144,
  256: 2_500_000,
  512: 10_000_000,
};

export function VoxelViewerCard({
  title,
  subtitle,
  voxelBuild,
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
  metrics?: { blockCount: number; warnings: string[]; generationTimeMs: number };
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
    const maxBlocks = VIEWER_MAX_BLOCKS_BY_GRID[gridSize] ?? VIEWER_MAX_BLOCKS_BY_GRID[256];
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
  const combinedError = error ?? rendered.error ?? undefined;
  const [preferredView, setPreferredView] = useState<"build" | "json">("build");
  const [showRawBuildJson, setShowRawBuildJson] = useState(false);

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
      ? "relative w-full h-[38vh] min-h-[220px] max-h-[300px] sm:h-[44vh] sm:min-h-[260px] sm:max-h-[360px] md:h-[52vh] md:min-h-[320px] md:max-h-[420px] lg:h-[56vh] lg:max-h-[480px] xl:h-[60vh] xl:max-h-[520px]"
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
  const showLoadingHud = Boolean(isLoading && showBuildView && showLoadingOverlay);
  const hudReceived = loadingProgress?.receivedBlocks ?? (build ? build.blocks.length : 0);
  const hudTotal = loadingProgress?.totalBlocks ?? null;
  const hudPct =
    typeof hudTotal === "number" && Number.isFinite(hudTotal) && hudTotal > 0
      ? Math.max(0, Math.min(1, hudReceived / hudTotal))
      : null;

  return (
    <div className="mb-panel">
      <div className="mb-panel-inner">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-bg/10 px-3 py-2 sm:px-4 sm:py-2.5">
          <div className="min-w-0 flex items-center gap-2.5">
            <div className="font-display text-[1.05rem] font-semibold tracking-tight text-fg sm:text-base">
              {title}
            </div>
            {subtitle ? (
              <div className="min-h-[1.1rem] text-[12px] sm:text-[13px]">{subtitle}</div>
            ) : null}
          </div>
          <div className="shrink-0 flex items-center gap-1.5 sm:gap-2">
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
            <div className="text-right text-[11px] text-muted sm:text-xs">
              {build ? (
                <>
                  <div className="flex flex-col items-end gap-0.5 sm:hidden">
                    <span className="font-mono">{blockCount} blocks</span>
                    {warnings.length ? (
                      <span className="font-mono">
                        {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <div className="hidden items-center gap-2 font-mono sm:flex">
                    <span>{blockCount} blocks</span>
                    {timing ? <span>• {timing}</span> : null}
                    {warnings.length ? (
                      <span>
                        • {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                </>
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
              autoRotate={autoRotate}
              // During progressive hydration, avoid restarting reveal animation on each chunk update.
              animateIn={Boolean(animateIn && !isLoading)}
              onBuildReadyChange={onBuildReadyChange}
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
            <div className="pointer-events-none absolute bottom-3 left-3 hidden gap-2 sm:flex">
              <span className="mb-badge">
                Drag to rotate • <span className="mb-kbd">Ctrl</span>+drag to pan • Scroll to zoom
              </span>
            </div>
          ) : null}

          {showLoadingHud ? (
            <div className="pointer-events-none absolute left-3 top-3 z-30">
              <div className="flex max-w-[92vw] flex-col gap-2 rounded-xl border border-border/70 bg-bg/55 px-3 py-2 text-xs text-muted shadow-soft backdrop-blur-sm sm:max-w-xs">
                <div className="flex items-center gap-2 text-fg/90">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                  <span className="font-medium">{loadingLabel}</span>
                </div>
                {hudPct != null ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/35">
                      <span
                        className="block h-full rounded-full bg-gradient-to-r from-accent/75 via-accent2/75 to-accent/75"
                        style={{ width: `${Math.max(1, Math.min(99, Math.round(hudPct * 100)))}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-muted/90">
                      <span>{hudReceived.toLocaleString()}</span>
                      <span>{hudTotal ? hudTotal.toLocaleString() : ""}</span>
                    </div>
                  </div>
                ) : build ? (
                  <div className="font-mono text-[11px] text-muted/90">
                    {blockCount.toLocaleString()} blocks
                  </div>
                ) : null}
                {(elapsed || (attempt && attempt > 1)) ? (
                  <div className="flex items-center gap-3 font-mono text-[11px] text-muted/80">
                    {elapsed ? <span>{elapsed}</span> : null}
                    {attempt && attempt > 1 ? <span>retry {attempt}</span> : null}
                  </div>
                ) : null}
                {retryReason ? (
                  <div className="text-[11px] text-muted/75">{retryReason}</div>
                ) : null}
              </div>
            </div>
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
            <div className="absolute inset-0 flex items-center justify-center bg-bg/70 px-4 text-center text-sm text-danger">
              <div className="flex w-full max-w-[92%] flex-col items-center gap-3">
                <div>{combinedError}</div>
                {hasJsonView && showViewToggle ? (
                  <div className="text-xs text-muted">Open JSON to inspect raw model output.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {combinedError && showJsonView ? (
            <div className="absolute left-3 right-3 top-14 rounded-md border border-danger/45 bg-danger/12 px-3 py-2 text-xs text-danger">
              {combinedError}
            </div>
          ) : null}

          {showBuildView && !build && !isLoading && !combinedError ? (
            <div className="absolute inset-0 flex items-center justify-center bg-bg/20 text-sm text-muted">
              No build yet
            </div>
          ) : null}

          {showJsonView && !hasJsonView && !isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-bg/20 text-sm text-muted">
              No JSON yet
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
