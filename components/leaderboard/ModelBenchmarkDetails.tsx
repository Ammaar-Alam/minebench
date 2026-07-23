"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  getModelBenchmarkProfile,
  type BenchmarkCost,
  type BenchmarkDuration,
  type BenchmarkOutputCap,
  type ModelBenchmarkProfile,
  type ModelRunParameter,
} from "@/lib/ai/modelBenchmarkProfiles";

const POPOVER_WIDTH = 340;
const VIEWPORT_GUTTER = 16;
const POPOVER_GAP = 4;
const BENCHMARK_PREDATES_TRACKING = "Benchmark predates tracking";

type DetailsPosition = {
  arrowLeft: number;
  left: number;
  placement: "above" | "below";
  top: number;
  width: number;
};

type ModelBenchmarkDetailsProps = {
  modelKey: string;
  displayName: string;
  className?: string;
};

type ModelBenchmarkDetailsTriggerProps = {
  displayName: string;
  expanded: boolean;
  controlsId: string;
  onToggle: () => void;
  className?: string;
};

type ModelBenchmarkDetailsInlineProps = {
  id: string;
  modelKey: string;
  displayName: string;
  open: boolean;
};

function InfoIcon() {
  return (
    <svg
      className="h-[15px] w-[15px]"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v3.5" />
      <path d="M8 5.25h.01" strokeWidth="2" />
    </svg>
  );
}

function resolveProfile(modelKey: string): ModelBenchmarkProfile {
  return (
    getModelBenchmarkProfile(modelKey) ?? {
      parameters: [{ label: "Configuration", value: "Not recorded" }],
      outputCap: {
        kind: "unavailable",
        reason: "predates-tracking",
      },
    }
  );
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatDuration(duration: BenchmarkDuration): string {
  const totalSeconds = duration.milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const secondsLabel = Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
  return minutes > 0 ? `${minutes}m ${secondsLabel}s` : `${secondsLabel}s`;
}

function formatJsonSize(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes >= 1) return `${mebibytes.toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatCost(cost: BenchmarkCost): string {
  return `$${cost.usd.toFixed(2)}`;
}

function formatOutputCap(outputCap: BenchmarkOutputCap): string {
  if (outputCap.kind === "exact") {
    return `${formatInteger(outputCap.tokens)} tokens`;
  }
  if (outputCap.kind === "variants") {
    return `${outputCap.tokens.map(formatInteger).join(" or ")} tokens`;
  }
  if (outputCap.reason === "varied-across-builds") {
    return "Varied across benchmark builds";
  }
  if (outputCap.reason === "accepted-cap-unrecorded") {
    return "Accepted cap not recorded";
  }
  if (outputCap.reason === "web-harness-unavailable") {
    return "Not available from web harness";
  }
  return BENCHMARK_PREDATES_TRACKING;
}

function parameterRows(profile: ModelBenchmarkProfile): ModelRunParameter[] {
  return [
    ...profile.parameters,
    {
      label: "Output cap",
      value: formatOutputCap(profile.outputCap),
    },
  ];
}

function statisticRows(profile: ModelBenchmarkProfile): ModelRunParameter[] {
  return [
    {
      label: "Average inference time",
      value: profile.averageInference
        ? formatDuration(profile.averageInference)
        : BENCHMARK_PREDATES_TRACKING,
    },
    {
      label: "Average JSON size",
      value:
        profile.averageJsonSizeBytes === undefined
          ? BENCHMARK_PREDATES_TRACKING
          : formatJsonSize(profile.averageJsonSizeBytes),
    },
    {
      label: "Total cost",
      value: profile.totalCost ? formatCost(profile.totalCost) : BENCHMARK_PREDATES_TRACKING,
    },
  ];
}

function DetailRows({ rows }: { rows: readonly ModelRunParameter[] }) {
  return (
    <dl className="mt-1 divide-y divide-border/60">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-3 py-2.5 text-[13px]"
        >
          <dt className="text-muted">{row.label}</dt>
          <dd className="text-right font-medium tabular-nums text-fg/95 [overflow-wrap:anywhere]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DetailsContent({
  modelKey,
  displayName,
  showHeader,
}: {
  modelKey: string;
  displayName: string;
  showHeader: boolean;
}) {
  const profile = resolveProfile(modelKey);
  const parameters = parameterRows(profile);
  const statistics = statisticRows(profile);
  const sectionId = useId();

  return (
    <>
      {showHeader ? (
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-fg">
            {displayName}
          </h2>
          {profile.sourceRelease ? (
            <span className="shrink-0 font-mono text-[11px] text-muted">
              v{profile.sourceRelease.replace(/^v/, "")}
            </span>
          ) : null}
        </div>
      ) : (
        <h2 className="sr-only">{displayName} run details</h2>
      )}

      <section
        className={showHeader ? "mt-3" : ""}
        aria-labelledby={`${sectionId}-parameters`}
      >
        <h3
          id={`${sectionId}-parameters`}
          className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted"
        >
          Parameters
        </h3>
        <DetailRows rows={parameters} />
      </section>

      <section
        className="mt-4 border-t border-border/70 pt-4"
        aria-labelledby={`${sectionId}-statistics`}
      >
        <h3
          id={`${sectionId}-statistics`}
          className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted"
        >
          Statistics
        </h3>
        <DetailRows rows={statistics} />
        {profile.note ? (
          <p className="mt-2 text-[13px] leading-relaxed text-muted">{profile.note}</p>
        ) : null}
      </section>
    </>
  );
}

export function ModelBenchmarkDetailsTrigger({
  displayName,
  expanded,
  controlsId,
  onToggle,
  className = "",
}: ModelBenchmarkDetailsTriggerProps) {
  return (
    <button
      type="button"
      className={`relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted2 transition-colors before:absolute before:-inset-y-2.5 before:-left-1 before:-right-4 before:content-[''] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${className}`}
      aria-label={`View ${displayName} run details`}
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <InfoIcon />
    </button>
  );
}

export function ModelBenchmarkDetailsInline({
  id,
  modelKey,
  displayName,
  open,
}: ModelBenchmarkDetailsInlineProps) {
  return (
    <div
      id={id}
      role="region"
      aria-label={`${displayName} run details`}
      hidden={!open}
      className="mt-3 border-t border-border/70 pt-3"
      onClick={(event) => event.stopPropagation()}
    >
      <DetailsContent modelKey={modelKey} displayName={displayName} showHeader={false} />
    </div>
  );
}

export function ModelBenchmarkDetails({
  modelKey,
  displayName,
  className = "",
}: ModelBenchmarkDetailsProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<DetailsPosition | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const detailsId = useId();

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;

    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const panelHeight = panelRef.current?.offsetHeight ?? 300;
    const spaceBelow = window.innerHeight - trigger.bottom - VIEWPORT_GUTTER;
    const placeAbove = spaceBelow < panelHeight + POPOVER_GAP && trigger.top > spaceBelow;
    const preferredTop = placeAbove
      ? trigger.top - panelHeight - POPOVER_GAP
      : trigger.bottom + POPOVER_GAP;
    const top = Math.max(
      VIEWPORT_GUTTER,
      Math.min(preferredTop, window.innerHeight - panelHeight - VIEWPORT_GUTTER),
    );
    const left = Math.max(
      VIEWPORT_GUTTER,
      Math.min(trigger.left - 12, window.innerWidth - width - VIEWPORT_GUTTER),
    );
    const arrowLeft = Math.max(
      12,
      Math.min(trigger.left + trigger.width / 2 - left, width - 12),
    );

    setPosition({
      arrowLeft,
      left,
      placement: placeAbove ? "above" : "below",
      top,
      width,
    });
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [modelKey]);

  useEffect(() => {
    if (!open) return;

    const frame = window.requestAnimationFrame(updatePosition);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [open, updatePosition]);

  return (
    <span ref={triggerRef} className={`inline-flex ${className}`}>
      <ModelBenchmarkDetailsTrigger
        displayName={displayName}
        expanded={open}
        controlsId={detailsId}
        onToggle={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setPosition(null);
          setOpen(true);
        }}
      />
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={detailsId}
              role="region"
              aria-label={`${displayName} run details`}
              className={`fixed z-30 overflow-visible rounded-lg border border-border bg-card shadow-soft ${
                position ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
              style={{
                left: position?.left ?? VIEWPORT_GUTTER,
                top: position?.top ?? VIEWPORT_GUTTER,
                width: position?.width ?? POPOVER_WIDTH,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {position ? (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-card ${
                    position.placement === "above"
                      ? "-bottom-[5px] border-b border-r border-border"
                      : "-top-[5px] border-l border-t border-border"
                  }`}
                  style={{ left: position.arrowLeft }}
                />
              ) : null}
              <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-[inherit] p-4">
                <DetailsContent modelKey={modelKey} displayName={displayName} showHeader />
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
