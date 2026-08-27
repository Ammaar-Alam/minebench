"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type VoxelLoadingProgress = {
  receivedBlocks: number;
  totalBlocks: number | null;
};

type VoxelLoadingHudProps = {
  label: string;
  progress?: VoxelLoadingProgress | null;
  elapsed?: string | null;
  attempt?: number;
  retryReason?: string;
  className?: string;
};

const POPOVER_WIDTH = 320;
const VIEWPORT_GUTTER = 16;
const POPOVER_GAP = 6;

type DetailsPosition = {
  arrowLeft: number;
  left: number;
  placement: "above" | "below";
  top: number;
  width: number;
};

function clampPercent(progress?: VoxelLoadingProgress | null): number | null {
  const total = progress?.totalBlocks ?? null;
  const received = progress?.receivedBlocks ?? 0;
  if (!total || total <= 0) return null;
  return Math.max(1, Math.min(99, Math.round((received / total) * 100)));
}

export function formatVoxelLoadingMessage(
  base: string,
  progress?: VoxelLoadingProgress | null,
): string {
  const total = progress?.totalBlocks ?? null;
  const received = progress?.receivedBlocks ?? 0;
  if (!total || total <= 0) {
    if (received > 0) return `${base} ${received.toLocaleString()} blocks`;
    return `${base}...`;
  }
  const pct = clampPercent(progress);
  return `${base} ${pct ?? 0}%`;
}

function VoxelRetryDetailsPopover({ retryReason }: { retryReason: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<DetailsPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const detailsId = useId();

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;

    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const panelHeight = panelRef.current?.offsetHeight ?? 180;
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
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Why MineBench is trying again"
        aria-expanded={open}
        aria-controls={detailsId}
        className="pointer-events-auto relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          setPosition(null);
          setOpen(true);
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </svg>
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={detailsId}
              role="region"
              aria-label="Retry details"
              className={`fixed z-50 overflow-visible rounded-md border border-border bg-card shadow-lg ${
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
              <div className="max-h-60 overflow-y-auto overscroll-contain rounded-[inherit] p-3 text-left">
                <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
                  <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
                    Retry details
                  </h3>
                </div>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted [overflow-wrap:anywhere]">
                  {retryReason}
                </pre>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function VoxelLoadingHud({
  label,
  progress,
  elapsed,
  attempt,
  retryReason,
  className = "pointer-events-none absolute left-3 top-3 z-30",
}: VoxelLoadingHudProps) {
  const total = progress?.totalBlocks ?? null;
  const pct = clampPercent(progress);

  return (
    <div className={className}>
      <div className="flex w-[13.5rem] max-w-[70vw] flex-col gap-1.5 rounded-md bg-bg/[0.55] px-2.5 py-1.5 backdrop-blur-sm sm:px-3">
        <div className="flex items-baseline justify-between gap-3 text-[10px] font-medium leading-none text-muted/70">
          <span className="truncate text-fg/65">{label}</span>
          {pct != null ? (
            <span className="shrink-0 font-mono tabular-nums">{pct}%</span>
          ) : null}
        </div>

        <div className="h-px w-full overflow-hidden bg-border/50">
          {pct != null ? (
            <span
              className="block h-full bg-accent/70 transition-[width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <span className="mb-progress-wait block h-full w-full" />
          )}
        </div>

        {(total || elapsed || (attempt && attempt > 1) || retryReason) ? (
          <div className="flex items-baseline justify-between gap-3 font-mono text-[10px] leading-none tabular-nums text-muted/45">
            <span>{elapsed ?? ""}</span>
            <div className="flex items-center gap-2">
              {retryReason ? (
                <VoxelRetryDetailsPopover retryReason={retryReason} />
              ) : null}
              {total ? <span className="shrink-0">{total.toLocaleString()}</span> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
