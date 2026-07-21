"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getModelBenchmarkProfile,
  type ModelBenchmarkProfile,
} from "@/lib/ai/modelBenchmarkProfiles";

function InfoIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 8.6v4.25" />
      <path d="M10 6.25h.01" strokeWidth="2.25" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function ModelBenchmarkDetails({
  modelKey,
  displayName,
  className = "",
}: {
  modelKey: string;
  displayName: string;
  className?: string;
}) {
  const recordedProfile = getModelBenchmarkProfile(modelKey);
  const profile: ModelBenchmarkProfile = recordedProfile ?? {
    parameters: [],
    note: "This model was benchmarked before run statistics were tracked.",
  };
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    triggerRef.current?.focus({ preventScroll: true });
  }, [open]);

  const hasRunStats = Boolean(profile.averageInferenceTime || profile.totalCost);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted2 ring-1 ring-border/80 transition hover:bg-accent/10 hover:text-accent hover:ring-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${className}`}
        aria-label={`View ${displayName} run details`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <InfoIcon />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[120] flex items-end justify-center bg-bg/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
              onMouseDown={() => setOpen(false)}
            >
              <section
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-card shadow-soft ring-1 ring-border"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-4 border-b border-border/80 px-4 py-4 sm:px-5">
                  <div className="min-w-0">
                    <div className="mb-eyebrow">Run details</div>
                    <h2 id={titleId} className="mt-1 truncate text-lg font-semibold tracking-tight text-fg">
                      {displayName}
                    </h2>
                  </div>
                  <button
                    ref={closeRef}
                    type="button"
                    className="mb-btn mb-btn-ghost h-8 w-8 shrink-0 rounded-full p-0"
                    aria-label="Close run details"
                    onClick={() => setOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>

                <div className="space-y-5 px-4 py-4 sm:px-5 sm:py-5">
                  {profile.parameters.length > 0 ? (
                    <div>
                      <h3 className="mb-eyebrow mb-2">Run setup</h3>
                      <dl className="divide-y divide-border/60 border-y border-border/60">
                        {profile.parameters.map((parameter) => (
                          <div
                            key={parameter.label}
                            className="flex items-baseline justify-between gap-5 py-2.5 text-sm"
                          >
                            <dt className="text-muted">{parameter.label}</dt>
                            <dd className="text-right font-medium text-fg">{parameter.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}

                  {hasRunStats ? (
                    <div>
                      <h3 className="mb-eyebrow mb-2">Benchmark run</h3>
                      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/70 ring-1 ring-border/70">
                        <div className="bg-bg/70 px-3 py-3">
                          <dt className="text-[11px] text-muted">Avg. inference</dt>
                          <dd className="mt-1 font-mono text-sm font-semibold text-fg">
                            {profile.averageInferenceTime ?? "—"}
                          </dd>
                        </div>
                        <div className="bg-bg/70 px-3 py-3">
                          <dt className="text-[11px] text-muted">Total cost</dt>
                          <dd className="mt-1 font-mono text-sm font-semibold text-fg">
                            {profile.totalCost ?? "—"}
                          </dd>
                        </div>
                      </dl>
                      <p className="mt-2 text-[11px] text-muted2">
                        {profile.buildCount
                          ? `Reported for a ${profile.buildCount}-build benchmark run.`
                          : "Reported for this benchmark run."}
                      </p>
                    </div>
                  ) : null}

                  {profile.note ? (
                    <p className="rounded-xl bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn ring-1 ring-warn/20">
                      {profile.note}
                    </p>
                  ) : null}
                  <p className="border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted2">
                    Ratings reflect the current prompt set
                    {profile.parameters.length > 0 ? " and run configuration shown" : ""}.
                    {profile.sourceRelease ? ` Source: MineBench ${profile.sourceRelease}.` : ""}
                  </p>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
