"use client";

import { useEffect, useMemo, useState } from "react";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { titleCase } from "@/components/lab/format";
import { readBuildVariantStream } from "@/lib/arena/clientBuildResponse";
import type { RenderableVoxelBuild } from "@/lib/voxel/packedBlocks";

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
  streamToken: string;
  gridSize: 64 | 256 | 512;
  palette: "simple" | "advanced";
  blockCount: number;
  diagnostics: {
    attempts: number;
    generationTimeMs: number;
  };
};

type LoadingProgress = { receivedBlocks: number; totalBlocks: number | null };

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

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // use the stable fallback
  }
  return fallback;
}

async function streamProtectedBuild(
  token: string,
  signal: AbortSignal,
  onProgress: (progress: LoadingProgress) => void,
): Promise<RenderableVoxelBuild> {
  const response = await fetch(
    `/api/arena/builds/${encodeURIComponent(token)}/stream?variant=full`,
    { cache: "no-store", signal },
  );
  if (!response.ok) throw new Error(await readError(response, "Build unavailable"));

  const decoded = await readBuildVariantStream(response, {
    signal,
    onProgress: (_build, progress) => {
      onProgress({
        receivedBlocks: progress.receivedBlocks,
        totalBlocks: progress.totalBlocks,
      });
    },
  });
  return decoded.voxelBuild;
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
  const [voxelBuild, setVoxelBuild] = useState<RenderableVoxelBuild | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
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
      setVoxelBuild(null);
      setLoadingProgress(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const resultId = selected.resultId;
    setLoading(true);
    setError(null);
    setPayload(null);
    setVoxelBuild(null);
    setLoadingProgress(null);

    void (async () => {
      try {
        const response = await fetch(
          `/api/lab/organizations/${encodeURIComponent(orgSlug)}/builds/${encodeURIComponent(resultId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = (await response.json()) as ProtectedBuildResponse | { error?: string };
        if (!response.ok) {
          throw new Error("error" in body && body.error ? body.error : "Build unavailable");
        }
        const metadata = body as ProtectedBuildResponse;
        const build = await streamProtectedBuild(
          metadata.streamToken,
          controller.signal,
          (progress) => {
            if (!controller.signal.aborted) setLoadingProgress(progress);
          },
        );
        if (controller.signal.aborted) return;
        setPayload(metadata);
        setVoxelBuild(build);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error && reason.message ? reason.message : "Build unavailable");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [orgSlug, selected?.resultId, selected?.status]);

  if (builds.length === 0) {
    return (
      <section className="py-8">
        <h2 className="text-lg font-semibold tracking-tight text-fg">No builds yet</h2>
      </section>
    );
  }

  const selectRelative = (offset: number) => {
    const next = filteredBuilds[selectedIndex + offset];
    if (next) setSelectedId(next.id);
  };
  const issueCount = builds.filter((build) => build.status === "FAILED" || build.error).length;
  const viewerMetrics = payload
    ? {
        blockCount: payload.blockCount,
        warnings: [],
        generationTimeMs: payload.diagnostics.generationTimeMs,
        attempts: payload.diagnostics.attempts,
      }
    : selected?.blockCount != null
      ? {
          blockCount: selected.blockCount,
          warnings: [],
          generationTimeMs: selected.generationTimeMs,
          attempts: selected.attempts,
        }
      : undefined;

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-bg" aria-labelledby="build-explorer-heading">
      <header className="grid border-b border-border/60 lg:grid-cols-[21rem_minmax(0,1fr)]">
        <div className="flex min-h-[3.75rem] items-center justify-between gap-4 px-4 lg:border-r lg:border-border/60">
          <div className="flex min-w-0 items-baseline gap-3">
            <h2 id="build-explorer-heading" className="truncate text-base font-semibold tracking-tight text-fg">
              Build explorer
            </h2>
            {issueCount > 0 ? <span className="shrink-0 text-[10px] text-danger">{issueCount} issues</span> : null}
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
            {filteredBuilds.length}/{builds.length}
          </span>
        </div>
        <div className="grid gap-2 border-t border-border/60 p-2 sm:grid-cols-[minmax(12rem,1fr)_9rem_8rem_auto] lg:border-t-0">
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
              className="mb-field h-11"
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
              className="mb-field h-11"
            >
              <option value="ALL">All statuses</option>
              <option value="READY">Ready</option>
              <option value="PENDING">In progress</option>
              <option value="ISSUES">Issues</option>
            </select>
          </label>
          <div className="flex overflow-hidden rounded-md border border-border/70">
            <button
              type="button"
              onClick={() => selectRelative(-1)}
              disabled={selectedIndex <= 0}
              aria-label="Previous build"
              className="grid h-11 w-11 place-items-center text-muted transition-colors hover:bg-card/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-30"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => selectRelative(1)}
              disabled={selectedIndex < 0 || selectedIndex >= filteredBuilds.length - 1}
              aria-label="Next build"
              className="grid h-11 w-11 place-items-center border-l border-border/70 text-muted transition-colors hover:bg-card/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-30"
            >
              →
            </button>
          </div>
        </div>
      </header>

      <div className="grid min-w-0 lg:grid-cols-[21rem_minmax(0,1fr)]">
        <div className="min-h-0 border-b border-border/60 lg:border-b-0 lg:border-r lg:border-border/60">
          <div className="mb-lab-scroll max-h-[19rem] overflow-y-auto overscroll-contain lg:max-h-[37rem]">
            {filteredBuilds.map((build, index) => {
              const active = build.id === selected?.id;
              return (
                <button
                  key={build.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedId(build.id)}
                  className={`group relative grid min-h-[4.5rem] w-full cursor-pointer grid-cols-[2rem_minmax(0,1fr)] gap-2 px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 ${
                    active ? "bg-card/50" : "hover:bg-card/35"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute inset-y-3 left-0 w-px origin-center bg-accent transition-transform duration-200 ease-out motion-reduce:transition-none ${
                      active ? "scale-y-100" : "scale-y-0"
                    }`}
                  />
                  <span className={`pt-0.5 font-mono text-[10px] tabular-nums transition-colors duration-150 ${active ? "text-fg" : "text-muted2 group-hover:text-muted"}`}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className={`line-clamp-2 text-sm font-medium leading-5 transition-[color,transform] duration-150 ease-out motion-reduce:transition-none ${active ? "text-accent" : "text-fg/90 group-hover:translate-x-0.5 group-hover:text-fg"}`}>
                      {build.prompt}
                    </span>
                    <span className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-muted">
                      <span className="truncate">{build.checkpoint}</span>
                      <span className={`flex shrink-0 items-center gap-1.5 ${statusTone(build.status)}`}>
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current transition-transform duration-150 group-hover:scale-125 motion-reduce:transition-none" />
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

        <div className="min-w-0 bg-card/10">
          {selected ? (
            selected.status === "READY" && selected.resultId ? (
              <VoxelViewerCard
                key={selected.resultId}
                title={payload?.checkpoint.codename ?? selected.checkpoint}
                subtitle={<span className="line-clamp-1 text-muted">{payload?.prompt ?? selected.prompt}</span>}
                voxelBuild={voxelBuild}
                gridSize={payload?.gridSize ?? 256}
                palette={payload?.palette ?? "simple"}
                expectedBlockCount={payload?.blockCount ?? selected.blockCount ?? undefined}
                isLoading={loading}
                loadingMessage="Loading build…"
                loadingProgress={loadingProgress ?? undefined}
                error={error ?? undefined}
                metrics={viewerMetrics}
                skipValidation
                embedded
              />
            ) : (
              <div className="grid min-h-[24rem] place-items-center p-7 text-center sm:min-h-[32rem]">
                <div className="max-w-sm">
                  <span className={`inline-flex items-center gap-2 text-xs font-medium ${statusTone(selected.status)}`}>
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                    {titleCase(selected.status)}
                  </span>
                  <h3 className="mt-3 text-xl font-semibold tracking-tight text-fg">Preview unavailable</h3>
                  {selected.error ? <p className="mt-2 text-sm text-danger">{selected.error}</p> : null}
                </div>
              </div>
            )
          ) : (
            <div className="grid min-h-[28rem] place-items-center p-6 text-sm text-muted">No matching builds</div>
          )}
        </div>
      </div>
    </section>
  );
}
