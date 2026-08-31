"use client";

import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { createRef, useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { GalleryVoteButton } from "@/components/gallery/GalleryVoteButton";
import { VoxelEmptyState } from "@/components/voxel/VoxelEmptyState";
import { readBuildVariantPayload } from "@/lib/arena/clientBuildResponse";
import type { GalleryCandidatePayload, GalleryExamplePayload } from "@/lib/gallery/service";
import { formatBuildDuration, formatBuildJsonSize } from "@/lib/buildMetrics";

const SandboxGifExportButton = dynamic(
  () => import("@/components/sandbox/SandboxGifExportButton").then((module) => module.SandboxGifExportButton),
  {
    ssr: false,
    loading: () => <button type="button" disabled className="mb-btn mb-btn-ghost h-8 px-2 text-xs text-muted">GIF</button>,
  },
);

type GalleryDetailPayload = GalleryCandidatePayload & {
  examples: GalleryExamplePayload[];
  nextExamplesCursor: string | null;
  navigation: {
    sort: "top" | "new";
    previousId: string | null;
    nextId: string | null;
  } | null;
};

type ExampleViewerState = {
  build: unknown | null;
  loading: boolean;
  error: string | null;
};

const MAX_COMPARISON_EXAMPLES = 4;
const RUN_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function galleryDetailHref(publicId: string, sort: "top" | "new") {
  return `/gallery/${publicId}${sort === "new" ? "?sort=new" : ""}`;
}

function GalleryNavigationArrow({
  direction,
  publicId,
  sort,
}: {
  direction: "previous" | "next";
  publicId: string | null;
  sort: "top" | "new";
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous build" : "Next build";
  const icon = (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-active:scale-90 motion-reduce:transform-none motion-reduce:transition-none ${previous ? "group-hover:-translate-x-0.5 group-active:-translate-x-1" : "group-hover:translate-x-0.5 group-active:translate-x-1"}`}
    >
      <path d={previous ? "M10 3.5L5.5 8L10 12.5" : "M6 3.5L10.5 8L6 12.5"} />
    </svg>
  );
  const divider = previous ? "" : "border-l border-border/70";

  if (!publicId) {
    return <span aria-hidden="true" className={`grid h-11 w-11 place-items-center text-muted/25 ${divider}`}>{icon}</span>;
  }
  return (
    <Link
      href={galleryDetailHref(publicId, sort)}
      aria-label={label}
      aria-keyshortcuts={previous ? "ArrowLeft" : "ArrowRight"}
      title={`${label} (${previous ? "Left" : "Right"} Arrow)`}
      className={`group grid h-11 w-11 place-items-center text-muted transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-card/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 active:bg-card/70 motion-reduce:transition-none ${divider}`}
    >
      {icon}
    </Link>
  );
}

function ReportDialog({
  open,
  candidate,
  onClose,
}: {
  open: boolean;
  candidate: GalleryDetailPayload;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState("candidate");
  const [reason, setReason] = useState("OFFENSIVE");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/gallery/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(target === "candidate" ? { candidateId: candidate.id } : { exampleId: target }),
          reason,
          note,
        }),
      });
      if (!response.ok) throw new Error("Report could not be sent");
      setSent(true);
    } catch {
      setError("Report could not be sent");
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="report-title" className="mb-dialog m-auto w-[min(32rem,calc(100%-2rem))] rounded-md border border-border bg-bg p-0 text-fg backdrop:bg-black/55" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
      {sent ? (
        <div className="space-y-6 p-6"><h2 id="report-title" className="text-2xl font-semibold">Report sent</h2><button type="button" className="mb-btn h-11 w-full" onClick={onClose}>Close</button></div>
      ) : (
        <form onSubmit={submit} className="space-y-5 p-6">
          <h2 id="report-title" className="text-2xl font-semibold">Report</h2>
          <label className="block space-y-2 text-sm"><span className="font-medium">Contribution</span><select className="mb-field h-11 w-full" value={target} onChange={(event) => setTarget(event.target.value)}><option value="candidate">Prompt</option>{candidate.examples.map((example) => <option key={example.id} value={example.id}>Example by {example.attribution}</option>)}</select></label>
          <label className="block space-y-2 text-sm"><span className="font-medium">Reason</span><select className="mb-field h-11 w-full" value={reason} onChange={(event) => setReason(event.target.value)}><option value="OFFENSIVE">Offensive</option><option value="SPAM">Spam</option><option value="MISLEADING">Misleading</option><option value="OTHER">Other</option></select></label>
          <label className="block space-y-2 text-sm"><span className="font-medium">Note <span className="text-muted">optional</span></span><textarea className="mb-field w-full resize-y py-2" rows={4} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          <div className="grid gap-2 sm:grid-cols-2"><button type="submit" disabled={pending} className="mb-btn mb-btn-primary h-11">{pending ? "Sending…" : "Send"}</button><button type="button" className="mb-btn h-11" onClick={onClose}>Cancel</button></div>
        </form>
      )}
    </dialog>
  );
}

export function GalleryDetail({ candidate }: { candidate: GalleryDetailPayload }) {
  const router = useRouter();
  const navigation = candidate.navigation;
  const [examples, setExamples] = useState(candidate.examples);
  const [nextExamplesCursor, setNextExamplesCursor] = useState(candidate.nextExamplesCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [examplesError, setExamplesError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>(examples[0] ? [examples[0].id] : []);
  const [compareMode, setCompareMode] = useState(false);
  const [viewerStates, setViewerStates] = useState<Record<string, ExampleViewerState>>({});
  const viewerStatesRef = useRef<Record<string, ExampleViewerState>>({});
  const viewerRefs = useRef(new Map<string, RefObject<VoxelViewerHandle | null>>());
  const viewerControllers = useRef(new Map<string, AbortController>());
  const [reportOpen, setReportOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const examplesScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = examplesScrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setCanScrollUp(scrollTop > 4);
    setCanScrollDown(scrollTop + clientHeight < scrollHeight - 4);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = examplesScrollRef.current;
    if (!el) return;
    const handleResize = () => updateScrollState();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [examples, updateScrollState]);

  function scrollExamples(direction: "up" | "down") {
    const el = examplesScrollRef.current;
    if (!el) return;
    const delta = direction === "up" ? -240 : 240;
    el.scrollBy({ top: delta, behavior: "smooth" });
  }
  const selectedExamples = selectedIds
    .map((id) => examples.find((example) => example.id === id))
    .filter((example): example is GalleryExamplePayload => Boolean(example));
  const selected = selectedExamples[0] ?? examples[0] ?? null;

  const getViewerRef = useCallback((exampleId: string) => {
    let viewerRef = viewerRefs.current.get(exampleId);
    if (!viewerRef) {
      viewerRef = createRef<VoxelViewerHandle>();
      viewerRefs.current.set(exampleId, viewerRef);
    }
    return viewerRef;
  }, []);

  const updateViewerState = useCallback((exampleId: string, state: ExampleViewerState) => {
    setViewerStates((current) => {
      const next = { ...current, [exampleId]: state };
      viewerStatesRef.current = next;
      return next;
    });
  }, []);

  async function removeCandidate() {
    if (!window.confirm("Remove this prompt from Gallery?")) return;
    setRemoving(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/gallery/candidates/${encodeURIComponent(candidate.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Prompt could not be removed");
      router.push("/gallery");
    } catch {
      setActionError("Prompt could not be removed");
      setRemoving(false);
    }
  }

  async function loadMoreExamples() {
    if (!nextExamplesCursor || loadingMore) return;
    setLoadingMore(true);
    setExamplesError(null);
    try {
      const response = await fetch(
        `/api/gallery/candidates/${encodeURIComponent(candidate.id)}?examplesCursor=${encodeURIComponent(nextExamplesCursor)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Examples unavailable");
      const body = await response.json() as { candidate: GalleryDetailPayload };
      setExamples((current) => {
        const existing = new Set(current.map((example) => example.id));
        return [...current, ...body.candidate.examples.filter((example) => !existing.has(example.id))];
      });
      setNextExamplesCursor(body.candidate.nextExamplesCursor);
    } catch {
      setExamplesError("Examples unavailable");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const selectedSet = new Set(selectedIds);

    for (const [exampleId, controller] of viewerControllers.current) {
      if (selectedSet.has(exampleId)) continue;
      controller.abort();
      viewerControllers.current.delete(exampleId);
    }
    for (const exampleId of viewerRefs.current.keys()) {
      if (!selectedSet.has(exampleId)) viewerRefs.current.delete(exampleId);
    }

    const retainedStates = Object.fromEntries(
      Object.entries(viewerStatesRef.current).filter(([exampleId]) => selectedSet.has(exampleId)),
    );
    if (Object.keys(retainedStates).length !== Object.keys(viewerStatesRef.current).length) {
      viewerStatesRef.current = retainedStates;
      setViewerStates(retainedStates);
    }

    for (const exampleId of selectedIds) {
      const example = examples.find((item) => item.id === exampleId);
      if (!example || viewerStatesRef.current[exampleId] || viewerControllers.current.has(exampleId)) continue;
      if (!example.viewerUrl) {
        updateViewerState(exampleId, { build: null, loading: false, error: "Viewer unavailable" });
        continue;
      }

      const controller = new AbortController();
      viewerControllers.current.set(exampleId, controller);
      updateViewerState(exampleId, { build: null, loading: true, error: null });
      void fetch(example.viewerUrl, { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("Viewer unavailable");
          return readBuildVariantPayload(response, {
            fallbackIdentity: { buildId: example.id, variant: "full", checksum: example.checksum },
          });
        })
        .then((result) => {
          if (!controller.signal.aborted) {
            updateViewerState(exampleId, { build: result.payload.voxelBuild, loading: false, error: null });
          }
        })
        .catch((viewerError) => {
          if (controller.signal.aborted || (viewerError instanceof Error && viewerError.name === "AbortError")) return;
          updateViewerState(exampleId, { build: null, loading: false, error: "Viewer unavailable" });
        })
        .finally(() => {
          if (viewerControllers.current.get(exampleId) === controller) {
            viewerControllers.current.delete(exampleId);
          }
        });
    }
  }, [examples, selectedIds, updateViewerState]);

  useEffect(() => () => {
    for (const controller of viewerControllers.current.values()) controller.abort();
    viewerControllers.current.clear();
    viewerStatesRef.current = {};
  }, []);

  useEffect(() => {
    if (!navigation || reportOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable ||
        target.closest("input, textarea, select, dialog, [contenteditable='true'], [role='menu']")
      )) return;
      const publicId = event.key === "ArrowLeft"
        ? navigation.previousId
        : event.key === "ArrowRight"
          ? navigation.nextId
          : null;
      if (!publicId) return;
      event.preventDefault();
      router.push(galleryDetailHref(publicId, navigation.sort));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigation, reportOpen, router]);

  function selectExample(event: React.MouseEvent<HTMLButtonElement>, exampleId: string) {
    const additive = event.metaKey || event.ctrlKey;
    if (compareMode && selectedIds.length === 1 && selectedIds[0] === exampleId) {
      setCompareMode(false);
      return;
    }
    if (!compareMode && !additive) {
      setSelectedIds([exampleId]);
      return;
    }

    if (additive) setCompareMode(true);
    setSelectedIds((current) => {
      if (current.includes(exampleId)) {
        return current.length === 1 ? current : current.filter((id) => id !== exampleId);
      }
      return current.length >= MAX_COMPARISON_EXAMPLES ? current : [...current, exampleId];
    });
  }

  function renderViewerCard(example: GalleryExamplePayload, isComparison: boolean) {
    const state = viewerStates[example.id];
    const build = state?.build ?? null;
    const loading = state?.loading ?? Boolean(example.viewerUrl);
    return (
      <VoxelViewerCard
        title={example.model.label}
        subtitle={`${example.attribution} · ${RUN_DATE_FORMAT.format(new Date(example.runAt))}`}
        voxelBuild={build}
        expectedBlockCount={example.blockCount ?? undefined}
        jsonBytes={example.jsonBytes}
        gridSize={example.gridSize === 64 || example.gridSize === 512 ? example.gridSize : 256}
        palette={example.palette}
        isLoading={loading}
        error={state?.error ?? undefined}
        skipValidation
        viewerSize={isComparison ? "arena" : "default"}
        enableBuildExport={Boolean(build)}
        exportLabel={example.model.label}
        exportPrompt={candidate.prompt}
        explorer={build && !loading ? {
          id: `gallery:${example.id}`,
          model: example.model.label,
          prompt: candidate.prompt,
          source: "gallery",
          checksum: example.checksum ?? null,
        } : undefined}
        viewerRef={getViewerRef(example.id)}
        metrics={example.blockCount != null ? {
          blockCount: example.blockCount,
          generationTimeMs: example.generationTimeMs ?? undefined,
          warnings: [],
        } : undefined}
        actions={!isComparison && build && !loading ? (
          <SandboxGifExportButton
            targets={[{
              viewerRef: getViewerRef(example.id),
              modelName: example.model.label,
              company: example.attribution,
              blockCount: example.blockCount ?? 0,
              generationTimeMs: example.generationTimeMs,
              jsonBytes: example.jsonBytes,
            }]}
            promptText={candidate.prompt}
            cancelKey={`${example.id}:${example.checksum ?? ""}`}
            label="GIF"
            embedded
          />
        ) : undefined}
      />
    );
  }

  const comparisonTargets = selectedExamples.length > 1 && selectedExamples.every((example) => viewerStates[example.id]?.build)
    ? selectedExamples.map((example) => ({
        viewerRef: getViewerRef(example.id),
        modelName: example.model.label,
        company: example.attribution,
        blockCount: example.blockCount ?? 0,
        generationTimeMs: example.generationTimeMs,
        jsonBytes: example.jsonBytes,
      }))
    : [];

  return (
    <article className="mb-fade-in mx-auto w-full max-w-7xl py-4 sm:py-8">
      <nav aria-label="Gallery navigation" className="flex items-center justify-between gap-4">
        <Link href={navigation?.sort === "new" ? "/gallery?sort=new" : "/gallery"} className="group inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted transition-colors hover:text-fg motion-reduce:transition-none">
          <span aria-hidden="true" className="transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none">←</span>
          Gallery
        </Link>
        {navigation ? (
          <div className="flex overflow-hidden rounded-md border border-border/70 bg-card/10">
            <GalleryNavigationArrow direction="previous" publicId={navigation.previousId} sort={navigation.sort} />
            <GalleryNavigationArrow direction="next" publicId={navigation.nextId} sort={navigation.sort} />
          </div>
        ) : null}
      </nav>

      <header className="mt-6 max-w-5xl sm:mt-8">
        <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.12em] text-muted"><span>By {candidate.attribution}</span>{candidate.selected ? <span className="text-accent">Official prompt</span> : null}</div>
        <h1 className="mt-3 text-balance font-display text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-4xl lg:text-5xl">{candidate.prompt}</h1>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <GalleryVoteButton candidateId={candidate.id} initialCount={candidate.upvoteCount} initialUpvoted={candidate.upvoted} />
          <Link href={`/sandbox?mode=live&prompt=${encodeURIComponent(candidate.prompt)}`} className="mb-btn mb-btn-primary h-11">Use prompt</Link>
        </div>
      </header>

      {actionError ? <p role="alert" className="mt-5 text-sm text-danger">{actionError}</p> : null}

      {selected ? (
        <section className="mt-10 grid gap-6 sm:mt-12 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start" aria-labelledby="viewer-title">
          {selectedExamples.length > 1 ? (
            <div className="min-w-0 self-start">
              <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-3">
                <p className="mb-eyebrow">Compare</p>
                <SandboxGifExportButton
                  targets={comparisonTargets}
                  promptText={candidate.prompt}
                  cancelKey={selectedExamples.map((example) => `${example.id}:${example.checksum ?? ""}`).join(":")}
                  label="GIF"
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {selectedExamples.map((example, index) => (
                  <div key={example.id} className={`min-w-0 mb-card-enter ${selectedExamples.length === 3 && index === 0 ? "md:col-span-2" : ""}`}>
                    {renderViewerCard(example, true)}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="min-w-0 self-start">
              {renderViewerCard(selected, false)}
            </div>
          )}
          <div className="min-w-0 self-start lg:sticky lg:top-4">
            <div className="flex min-h-9 items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 id="viewer-title" className="mb-eyebrow">Examples</h2>
                {examples.length > 1 ? (
                  <span className="rounded-full border border-border/70 bg-card/20 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    {examples.length}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                {examples.length > 2 ? (
                  <div className="hidden items-center gap-1 lg:flex">
                    <button
                      type="button"
                      aria-label="Previous example"
                      disabled={!canScrollUp}
                      onClick={() => scrollExamples("up")}
                      className="grid h-7 w-7 place-items-center rounded border border-border/70 bg-card/20 text-muted transition-[background-color,color,opacity] hover:bg-card/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:pointer-events-none disabled:opacity-20 motion-reduce:transition-none"
                    >
                      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                        <path d="M3.5 10L8 5.5L12.5 10" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="Next example"
                      disabled={!canScrollDown}
                      onClick={() => scrollExamples("down")}
                      className="grid h-7 w-7 place-items-center rounded border border-border/70 bg-card/20 text-muted transition-[background-color,color,opacity] hover:bg-card/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:pointer-events-none disabled:opacity-20 motion-reduce:transition-none"
                    >
                      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                        <path d="M3.5 6L8 10.5L12.5 6" />
                      </svg>
                    </button>
                  </div>
                ) : null}
                {examples.length > 1 ? (
                  <button
                    type="button"
                    aria-pressed={compareMode}
                    className="min-h-8 rounded px-2 text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 motion-reduce:transition-none"
                    onClick={() => {
                      if (compareMode) {
                        setCompareMode(false);
                        setSelectedIds(selectedIds.slice(0, 1));
                      } else {
                        setCompareMode(true);
                      }
                    }}
                  >
                    {compareMode ? "Single" : "Compare"}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="relative mt-3">
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 hidden h-8 bg-gradient-to-b from-bg to-transparent transition-opacity duration-200 lg:block ${canScrollUp ? "opacity-100" : "opacity-0"}`}
              />
              <div
                ref={examplesScrollRef}
                onScroll={updateScrollState}
                className="grid grid-cols-2 gap-2 lg:max-h-[520px] xl:max-h-[560px] lg:flex lg:flex-col lg:overflow-y-auto lg:overscroll-contain lg:scroll-smooth lg:snap-y lg:snap-proximity [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {examples.map((example) => {
                  const selectedOrder = selectedIds.indexOf(example.id);
                  const atLimit = compareMode && selectedOrder < 0 && selectedIds.length >= MAX_COMPARISON_EXAMPLES;
                  return (
                    <button
                      key={example.id}
                      type="button"
                      aria-pressed={selectedOrder >= 0}
                      aria-disabled={atLimit || undefined}
                      onClick={(event) => selectExample(event, example.id)}
                      className={`group/example relative min-w-0 shrink-0 snap-start overflow-hidden rounded-md border text-left transition-[transform,border-color,background-color,opacity,box-shadow] duration-200 ease-out hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none ${
                        selectedOrder >= 0
                          ? "border-accent/65 bg-accent/5 shadow-soft"
                          : "border-border bg-card/10 hover:border-muted hover:bg-card/20"
                      } ${atLimit ? "opacity-50" : ""}`}
                    >
                      {compareMode && selectedOrder >= 0 ? (
                        <span aria-hidden="true" className="absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-full bg-accent text-xs font-semibold text-bg shadow-soft">
                          {selectedOrder + 1}
                        </span>
                      ) : null}
                      {example.previewUrl ? (
                        <div className="relative aspect-[16/9] bg-bg">
                          <Image
                            src={example.previewUrl}
                            alt=""
                            fill
                            unoptimized
                            sizes="18rem"
                            className="object-contain p-1.5 transition-transform duration-300 ease-out group-hover/example:scale-[1.025] motion-reduce:transition-none"
                          />
                        </div>
                      ) : null}
                      <div className="p-3">
                        <p className="truncate text-sm font-medium text-fg">{example.model.label}</p>
                        <p className="mt-1 truncate text-xs text-muted">
                          {example.attribution} · <time dateTime={example.runAt}>{RUN_DATE_FORMAT.format(new Date(example.runAt))}</time>
                        </p>
                        <p className="mt-2 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted">
                          {example.blockCount != null ? <span>{example.blockCount.toLocaleString()} blocks</span> : null}
                          {formatBuildJsonSize(example.jsonBytes) ? <span>{formatBuildJsonSize(example.jsonBytes)} JSON</span> : null}
                          {formatBuildDuration(example.generationTimeMs) ? <span>{formatBuildDuration(example.generationTimeMs)}</span> : null}
                        </p>
                      </div>
                    </button>
                  );
                })}
                {nextExamplesCursor ? (
                  <button
                    type="button"
                    className="mb-btn mt-1 h-10 w-full shrink-0"
                    disabled={loadingMore}
                    onClick={() => void loadMoreExamples()}
                  >
                    {loadingMore ? "Loading…" : "More examples"}
                  </button>
                ) : null}
              </div>
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 hidden h-6 bg-gradient-to-t from-bg to-transparent transition-opacity duration-200 lg:block ${canScrollDown ? "opacity-100" : "opacity-0"}`}
              />
            </div>
            {examplesError ? <p className="mt-2 text-xs text-danger">{examplesError}</p> : null}
          </div>
        </section>
      ) : (
        <div className="relative mt-10 min-h-56 overflow-hidden rounded-md border border-border/80 bg-card/15 sm:mt-12 sm:aspect-[16/5]"><VoxelEmptyState /></div>
      )}

      <footer className="mt-8 flex flex-wrap items-center gap-5 text-sm text-muted sm:mt-10">
        {candidate.canRemove ? <button type="button" disabled={removing} className="min-h-11 transition-colors hover:text-danger disabled:opacity-65 motion-reduce:transition-none" onClick={() => void removeCandidate()}>{removing ? "Removing…" : "Remove prompt"}</button> : null}
        <button type="button" className="min-h-11 transition-colors hover:text-fg motion-reduce:transition-none" onClick={() => setReportOpen(true)}>Report</button>
      </footer>
      <ReportDialog open={reportOpen} candidate={{ ...candidate, examples }} onClose={() => setReportOpen(false)} />
    </article>
  );
}
