"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  getModelBenchmarkProfile,
  type ModelBenchmarkProfile,
  type ModelRunParameter,
} from "@/lib/ai/modelBenchmarkProfiles";

const UNTRACKED_RUN_NOTE = "This model was benchmarked before run statistics were tracked.";
const POPOVER_WIDTH = 340;
const VIEWPORT_GUTTER = 16;
const POPOVER_GAP = 4;

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
    }
  );
}

function statisticRows(profile: ModelBenchmarkProfile): ModelRunParameter[] {
  const rows: ModelRunParameter[] = [];
  if (profile.averageInferenceTime) {
    rows.push({ label: "Avg. inference", value: profile.averageInferenceTime });
  }
  if (profile.totalCost) {
    rows.push({ label: "Total cost", value: profile.totalCost });
  }

  return rows;
}

function DetailRows({ rows }: { rows: readonly ModelRunParameter[] }) {
  return (
    <dl className="mt-1 divide-y divide-border/60 border-y border-border/70">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-4 py-2.5 text-xs"
        >
          <dt className="text-muted2">{row.label}</dt>
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
            <span className="shrink-0 font-mono text-[10px] text-muted2">
              v{profile.sourceRelease.replace(/^v/, "")}
            </span>
          ) : null}
        </div>
      ) : null}

      <section
        className={showHeader ? "mt-3" : ""}
        aria-labelledby={`${sectionId}-parameters`}
      >
        <h3
          id={`${sectionId}-parameters`}
          className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted2"
        >
          Parameters
        </h3>
        <DetailRows rows={profile.parameters} />
      </section>

      <section className="mt-4" aria-labelledby={`${sectionId}-statistics`}>
        <h3
          id={`${sectionId}-statistics`}
          className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted2"
        >
          Statistics
        </h3>
        {statistics.length > 0 ? (
          <DetailRows rows={statistics} />
        ) : (
          <p className="mt-1 border-y border-border/70 py-2.5 text-xs leading-relaxed text-muted">
            {UNTRACKED_RUN_NOTE}
          </p>
        )}
        {profile.note ? (
          <p className="mt-2 text-xs leading-relaxed text-muted">{profile.note}</p>
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
          if (!open) updatePosition();
          setOpen((current) => !current);
        }}
      />
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={detailsId}
              role="region"
              aria-label={`${displayName} run details`}
              className={`fixed z-30 overflow-visible rounded-lg border border-border bg-card shadow-[0_18px_45px_-30px_rgba(0,0,0,0.65)] ${
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
