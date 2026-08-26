"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { GalleryBuildPlaceholder } from "@/components/gallery/GalleryBuildPlaceholder";
import { GalleryVoteButton } from "@/components/gallery/GalleryVoteButton";
import { readBuildVariantPayload } from "@/lib/arena/clientBuildResponse";
import type { GalleryCandidatePayload, GalleryExamplePayload } from "@/lib/gallery/service";

type GalleryDetailPayload = GalleryCandidatePayload & {
  examples: GalleryExamplePayload[];
  nextExamplesCursor: string | null;
};

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
    <dialog ref={ref} aria-labelledby="report-title" className="m-auto w-[min(32rem,calc(100%-2rem))] border border-border bg-bg p-0 text-fg backdrop:bg-black/55" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
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
  const [examples, setExamples] = useState(candidate.examples);
  const [nextExamplesCursor, setNextExamplesCursor] = useState(candidate.nextExamplesCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [examplesError, setExamplesError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(examples[0]?.id ?? null);
  const [build, setBuild] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const selected = examples.find((example) => example.id === selectedId) ?? examples[0] ?? null;

  async function removeCandidate() {
    if (!window.confirm("Remove this prompt from Gallery?")) return;
    setRemoving(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/gallery/candidates/${encodeURIComponent(candidate.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Prompt could not be removed");
      window.location.assign("/gallery");
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
    if (!selected?.viewerUrl) {
      setBuild(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(selected.viewerUrl, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Viewer unavailable");
        return readBuildVariantPayload(response, {
          fallbackIdentity: { buildId: selected.id, variant: "full", checksum: selected.checksum },
        });
      })
      .then((result) => setBuild(result.payload.voxelBuild))
      .catch((viewerError) => {
        if (viewerError instanceof Error && viewerError.name === "AbortError") return;
        setError("Viewer unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected]);

  return (
    <article className="mx-auto w-full max-w-7xl py-4 sm:py-8">
      <nav aria-label="Breadcrumb">
        <Link href="/gallery" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted hover:text-fg">
          <span aria-hidden="true">←</span>
          Gallery
        </Link>
      </nav>

      <header className="mt-6 max-w-5xl sm:mt-8">
        <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.12em] text-muted"><span>By {candidate.attribution}</span>{candidate.selected ? <span className="text-accent">Selected</span> : null}</div>
        <h1 className="mt-3 text-balance font-display text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-4xl lg:text-5xl">{candidate.prompt}</h1>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <GalleryVoteButton candidateId={candidate.id} initialCount={candidate.upvoteCount} initialUpvoted={candidate.upvoted} />
          <Link href={`/sandbox?mode=live&prompt=${encodeURIComponent(candidate.prompt)}`} className="mb-btn mb-btn-primary h-11">Use prompt</Link>
        </div>
      </header>

      {actionError ? <p role="alert" className="mt-5 text-sm text-danger">{actionError}</p> : null}

      {selected ? (
        <section className="mt-10 grid gap-6 sm:mt-12 lg:grid-cols-[minmax(0,1fr)_18rem]" aria-labelledby="viewer-title">
          <VoxelViewerCard
            title={selected.model.label}
            subtitle={`By ${selected.attribution}`}
            voxelBuild={build}
            expectedBlockCount={selected.blockCount ?? undefined}
            gridSize={selected.gridSize === 64 || selected.gridSize === 512 ? selected.gridSize : 256}
            palette={selected.palette}
            isLoading={loading}
            error={error ?? undefined}
            skipValidation
            enableBuildExport={Boolean(build)}
            exportLabel={selected.model.label}
            exportPrompt={candidate.prompt}
          />
          <div>
            <h2 id="viewer-title" className="mb-eyebrow">Examples</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-1">
              {examples.map((example) => (
                <button key={example.id} type="button" aria-pressed={example.id === selected.id} onClick={() => setSelectedId(example.id)} className={`min-w-0 border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${example.id === selected.id ? "border-fg" : "border-border hover:border-muted"}`}>
                  {example.previewUrl ? <div className="relative aspect-[16/9] border-b border-border bg-bg"><Image src={example.previewUrl} alt="" fill unoptimized sizes="18rem" className="object-contain p-2" /></div> : null}
                  <div className="p-3"><p className="truncate text-sm font-medium text-fg">{example.model.label}</p><p className="mt-1 truncate text-xs text-muted">{example.attribution}</p></div>
                </button>
              ))}
            </div>
            {nextExamplesCursor ? (
              <button type="button" className="mb-btn mt-3 h-10 w-full" disabled={loadingMore} onClick={() => void loadMoreExamples()}>
                {loadingMore ? "Loading…" : "More examples"}
              </button>
            ) : null}
            {examplesError ? <p className="mt-2 text-xs text-danger">{examplesError}</p> : null}
          </div>
        </section>
      ) : (
        <GalleryBuildPlaceholder className="mt-10 min-h-56 border border-border/80 sm:mt-12 sm:aspect-[16/5]" />
      )}

      <footer className="mt-8 flex flex-wrap items-center gap-5 text-sm text-muted sm:mt-10">
        {candidate.canRemove ? <button type="button" disabled={removing} className="min-h-11 hover:text-danger disabled:opacity-65" onClick={() => void removeCandidate()}>{removing ? "Removing…" : "Remove prompt"}</button> : null}
        <button type="button" className="min-h-11 hover:text-fg" onClick={() => setReportOpen(true)}>Report</button>
      </footer>
      <ReportDialog open={reportOpen} candidate={{ ...candidate, examples }} onClose={() => setReportOpen(false)} />
    </article>
  );
}
