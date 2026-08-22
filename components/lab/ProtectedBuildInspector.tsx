"use client";

import { useEffect, useMemo, useState } from "react";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { formatDuration } from "@/components/lab/format";

export type ProtectedBuildOption = {
  resultId: string;
  checkpoint: string;
  prompt: string;
  blockCount: number | null;
  attempts: number;
  generationTimeMs: number;
};

type ProtectedBuildResponse = {
  resultId: string;
  prompt: string;
  checkpoint: { codename: string; source: string };
  voxelBuild: unknown;
  gridSize: 64 | 256 | 512;
  palette: "simple" | "advanced";
  blockCount: number;
  diagnostics: {
    attempts: number;
    generationTimeMs: number;
  };
};

export function ProtectedBuildInspector({
  orgSlug,
  builds,
}: {
  orgSlug: string;
  builds: ProtectedBuildOption[];
}) {
  const [selectedId, setSelectedId] = useState(builds[0]?.resultId ?? "");
  const [payload, setPayload] = useState<ProtectedBuildResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(builds[0]));
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => builds.find((build) => build.resultId === selectedId) ?? builds[0] ?? null,
    [builds, selectedId],
  );

  useEffect(() => {
    if (!selected?.resultId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPayload(null);

    void fetch(
      `/api/lab/organizations/${encodeURIComponent(orgSlug)}/builds/${encodeURIComponent(selected.resultId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const body = (await response.json()) as ProtectedBuildResponse | { error?: string };
        if (!response.ok) {
          throw new Error("error" in body && body.error ? body.error : "Build unavailable");
        }
        setPayload(body as ProtectedBuildResponse);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error && reason.message ? reason.message : "Build unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [orgSlug, selected]);

  if (!selected) {
    return (
      <section className="border-y border-border/70 py-8">
        <h2 className="text-lg font-medium tracking-tight text-fg">No builds yet</h2>
        <p className="mt-2 text-sm text-muted">Completed builds will appear here.</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="lg:hidden">
        <label htmlFor="lab-build-select" className="mb-2 block text-xs font-medium text-muted">
          Build
        </label>
        <select
          id="lab-build-select"
          value={selected.resultId}
          onChange={(event) => setSelectedId(event.target.value)}
          className="mb-field h-11"
        >
          {builds.map((build) => (
            <option key={build.resultId} value={build.resultId}>
              {build.checkpoint} · {build.prompt}
            </option>
          ))}
        </select>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
        <div className="hidden max-h-[42rem] overflow-y-auto border-y border-border/70 lg:block">
          {builds.map((build) => {
            const active = build.resultId === selected.resultId;
            return (
              <button
                key={build.resultId}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedId(build.resultId)}
                className={`block min-h-11 w-full border-b border-border/45 px-1 py-3 text-left last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 ${
                  active ? "bg-accent/[0.07]" : "hover:bg-bg/45"
                }`}
              >
                <span className="block truncate text-sm font-medium text-fg">{build.prompt}</span>
                <span className="mt-1 flex items-center justify-between gap-3 text-xs text-muted">
                  <span>{build.checkpoint}</span>
                  <span className="font-mono tabular-nums">
                    {build.blockCount?.toLocaleString() ?? "—"} blocks
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-w-0 lg:sticky lg:top-28">
          <VoxelViewerCard
            key={selected.resultId}
            title={payload?.checkpoint.codename ?? selected.checkpoint}
            subtitle={<span className="line-clamp-1 text-muted">{payload?.prompt ?? selected.prompt}</span>}
            voxelBuild={payload?.voxelBuild ?? null}
            gridSize={payload?.gridSize ?? 256}
            palette={payload?.palette ?? "simple"}
            expectedBlockCount={payload?.blockCount ?? selected.blockCount ?? undefined}
            autoRotate={false}
            isLoading={loading}
            loadingMessage="Loading build…"
            error={error ?? undefined}
            metrics={
              payload
                ? {
                    blockCount: payload.blockCount,
                    warnings: [],
                    generationTimeMs: payload.diagnostics.generationTimeMs,
                  }
                : undefined
            }
            skipValidation
          />
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
            <span>{selected.attempts.toLocaleString()} attempts</span>
            <span>{formatDuration(selected.generationTimeMs)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
