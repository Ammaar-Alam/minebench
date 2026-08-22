"use client";

import { useEffect, useMemo, useState } from "react";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { formatDuration, titleCase } from "@/components/lab/format";

export type ProtectedBuildOption = {
  id: string;
  resultId: string | null;
  checkpointId: string;
  checkpoint: string;
  promptId: string;
  prompt: string;
  status: string;
  error: string | null;
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

type BuildFilter = "ALL" | "READY" | "PENDING" | "ISSUES";

function matchesStatus(build: ProtectedBuildOption, filter: BuildFilter): boolean {
  if (filter === "READY") return build.status === "READY";
  if (filter === "ISSUES") return build.status === "FAILED" || Boolean(build.error);
  if (filter === "PENDING") return build.status !== "READY" && build.status !== "FAILED";
  return true;
}

function statusTone(status: string): string {
  if (status === "READY") return "text-success";
  if (status === "FAILED") return "text-danger";
  if (status === "GENERATING" || status === "VALIDATING" || status === "RUNNING") return "text-warn";
  return "text-muted";
}

export function ProtectedBuildInspector({
  orgSlug,
  builds,
}: {
  orgSlug: string;
  builds: ProtectedBuildOption[];
}) {
  const initialBuild = builds.find((build) => build.status === "READY") ?? builds[0] ?? null;
  const [selectedId, setSelectedId] = useState(initialBuild?.id ?? "");
  const [checkpointFilter, setCheckpointFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState<BuildFilter>("ALL");
  const [query, setQuery] = useState("");
  const [payload, setPayload] = useState<ProtectedBuildResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(initialBuild?.resultId));
  const [error, setError] = useState<string | null>(null);

  const checkpoints = useMemo(() => {
    const unique = new Map<string, string>();
    for (const build of builds) unique.set(build.checkpointId, build.checkpoint);
    return Array.from(unique, ([id, name]) => ({ id, name }));
  }, [builds]);

  const filteredBuilds = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return builds.filter(
      (build) =>
        (checkpointFilter === "ALL" || build.checkpointId === checkpointFilter) &&
        matchesStatus(build, statusFilter) &&
        (!normalizedQuery ||
          build.prompt.toLowerCase().includes(normalizedQuery) ||
          build.checkpoint.toLowerCase().includes(normalizedQuery)),
    );
  }, [builds, checkpointFilter, query, statusFilter]);

  const selected =
    filteredBuilds.find((build) => build.id === selectedId) ?? filteredBuilds[0] ?? null;
  const selectedIndex = selected ? filteredBuilds.findIndex((build) => build.id === selected.id) : -1;

  useEffect(() => {
    if (!selected?.resultId || selected.status !== "READY") {
      setPayload(null);
      setLoading(false);
      setError(null);
      return;
    }

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
  }, [orgSlug, selected?.resultId, selected?.status]);

  if (builds.length === 0) {
    return (
      <section className="rounded-3xl border border-dashed border-border bg-card/30 p-8">
        <h2 className="text-xl font-semibold tracking-tight text-fg">No builds yet</h2>
        <p className="mt-2 text-sm text-muted">Completed builds will appear here.</p>
      </section>
    );
  }

  const selectRelative = (offset: number) => {
    const next = filteredBuilds[selectedIndex + offset];
    if (next) setSelectedId(next.id);
  };

  return (
    <section className="overflow-hidden rounded-3xl border border-border/70 bg-card/55 shadow-soft" aria-labelledby="build-explorer-heading">
      <header className="grid gap-4 border-b border-border/60 p-4 sm:p-5 xl:grid-cols-[minmax(11rem,1fr)_minmax(15rem,1.2fr)_auto_auto] xl:items-end">
        <div>
          <p className="mb-eyebrow">Cohort</p>
          <h2 id="build-explorer-heading" className="mt-1.5 text-xl font-semibold tracking-tight text-fg">
            Build explorer
          </h2>
        </div>
        <label className="relative block">
          <span className="sr-only">Search builds</span>
          <svg viewBox="0 0 20 20" aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted2" fill="none">
            <circle cx="8.8" cy="8.8" r="5.2" stroke="currentColor" strokeWidth="1.4" />
            <path d="m12.7 12.7 3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search prompts"
            className="mb-field h-11 pl-10"
          />
        </label>
        <label>
          <span className="sr-only">Checkpoint</span>
          <select
            value={checkpointFilter}
            onChange={(event) => setCheckpointFilter(event.target.value)}
            className="mb-field h-11 min-w-36"
          >
            <option value="ALL">All checkpoints</option>
            {checkpoints.map((checkpoint) => (
              <option key={checkpoint.id} value={checkpoint.id}>
                {checkpoint.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Build status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as BuildFilter)}
            className="mb-field h-11 min-w-32"
          >
            <option value="ALL">All statuses</option>
            <option value="READY">Ready</option>
            <option value="PENDING">In progress</option>
            <option value="ISSUES">Issues</option>
          </select>
        </label>
      </header>

      <div className="grid min-w-0 lg:grid-cols-[21rem_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-b border-border/60 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between border-b border-border/55 px-4 py-3 text-xs text-muted">
            <span>{filteredBuilds.length} shown</span>
            <span className="font-mono tabular-nums">{builds.length} total</span>
          </div>
          <div className="max-h-[20rem] overflow-y-auto overscroll-contain lg:max-h-[39rem]">
            {filteredBuilds.map((build, index) => {
              const active = build.id === selected?.id;
              return (
                <button
                  key={build.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedId(build.id)}
                  className={`grid min-h-[4.75rem] w-full grid-cols-[2rem_minmax(0,1fr)] gap-2 border-b border-border/45 px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 last:border-0 ${
                    active ? "bg-accent/[0.08]" : "hover:bg-bg/45"
                  }`}
                >
                  <span className={`pt-0.5 font-mono text-[10px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-sm font-medium leading-5 text-fg">{build.prompt}</span>
                    <span className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-muted">
                      <span className="truncate">{build.checkpoint}</span>
                      <span className={`flex shrink-0 items-center gap-1.5 ${statusTone(build.status)}`}>
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                        {titleCase(build.status)}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
            {filteredBuilds.length === 0 ? (
              <div className="p-6 text-sm text-muted">No matching builds.</div>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 p-3 sm:p-5">
          {selected ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">{selected.checkpoint}</p>
                  <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted">
                    {selectedIndex + 1} / {filteredBuilds.length}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => selectRelative(-1)}
                    disabled={selectedIndex <= 0}
                    aria-label="Previous build"
                    className="grid h-10 w-10 place-items-center rounded-xl border border-border/70 text-muted transition hover:bg-bg/60 hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => selectRelative(1)}
                    disabled={selectedIndex < 0 || selectedIndex >= filteredBuilds.length - 1}
                    aria-label="Next build"
                    className="grid h-10 w-10 place-items-center rounded-xl border border-border/70 text-muted transition hover:bg-bg/60 hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    →
                  </button>
                </div>
              </div>

              {selected.status === "READY" && selected.resultId ? (
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
              ) : (
                <div className="grid min-h-[20rem] place-items-center rounded-2xl border border-dashed border-border bg-bg/35 p-7 text-center sm:min-h-[26rem]">
                  <div className="max-w-sm">
                    <span className={`inline-flex items-center gap-2 text-xs font-medium ${statusTone(selected.status)}`}>
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                      {titleCase(selected.status)}
                    </span>
                    <h3 className="mt-3 text-xl font-semibold tracking-tight text-fg">Preview unavailable</h3>
                    {selected.error ? <p className="mt-2 text-sm text-danger">{selected.error}</p> : null}
                  </div>
                </div>
              )}

              <dl className="mt-3 grid grid-cols-3 divide-x divide-border/60 rounded-2xl border border-border/60 bg-bg/35 py-3 text-center">
                <div className="px-2">
                  <dt className="text-[9px] uppercase tracking-[0.1em] text-muted2">Blocks</dt>
                  <dd className="mt-1 font-mono text-xs tabular-nums text-fg">
                    {selected.blockCount?.toLocaleString() ?? "—"}
                  </dd>
                </div>
                <div className="px-2">
                  <dt className="text-[9px] uppercase tracking-[0.1em] text-muted2">Attempts</dt>
                  <dd className="mt-1 font-mono text-xs tabular-nums text-fg">
                    {selected.attempts.toLocaleString()}
                  </dd>
                </div>
                <div className="px-2">
                  <dt className="text-[9px] uppercase tracking-[0.1em] text-muted2">Time</dt>
                  <dd className="mt-1 font-mono text-xs tabular-nums text-fg">
                    {formatDuration(selected.generationTimeMs)}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <div className="grid min-h-[28rem] place-items-center text-sm text-muted">Choose another filter.</div>
          )}
        </div>
      </div>
    </section>
  );
}
