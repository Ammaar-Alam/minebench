"use client";

import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { readBuildVariantPayload } from "@/lib/arena/clientBuildResponse";
import { downloadSavedGenerationJson } from "@/lib/generations/download";
import type { SavedGenerationPayload } from "@/lib/generations/service";

const VoxelViewerCard = dynamic(
  () => import("@/components/voxel/VoxelViewerCard").then((module) => module.VoxelViewerCard),
  { ssr: false },
);

const SandboxGifExportButton = dynamic(
  () => import("@/components/sandbox/SandboxGifExportButton").then((module) => module.SandboxGifExportButton),
  {
    ssr: false,
    loading: () => <button type="button" disabled className="mb-btn mb-btn-ghost h-8 px-2 text-xs text-muted">GIF</button>,
  },
);

function statusLabel(value: SavedGenerationPayload["status"]): string {
  if (value === "succeeded") return "Ready";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const kibibytes = value / 1024;
  if (kibibytes < 1024) return `${kibibytes.toFixed(kibibytes >= 10 ? 0 : 1)} KiB`;
  const mebibytes = kibibytes / 1024;
  return `${mebibytes.toFixed(mebibytes >= 10 ? 1 : 2)} MiB`;
}

function GenerationDownloadButton({
  generation,
  compact = false,
  onError,
}: {
  generation: SavedGenerationPayload;
  compact?: boolean;
  onError: (message: string | null) => void;
}) {
  const [pending, setPending] = useState(false);

  if (!generation.downloadUrl) return null;
  return (
    <button
      type="button"
      disabled={pending}
      aria-label="Download JSON"
      title="Download expanded JSON"
      className={compact
        ? "mb-btn mb-btn-ghost h-8 w-8 border border-border/70 bg-bg/55 p-0 text-muted hover:text-fg"
        : "relative inline-flex h-10 items-center px-2 text-sm font-semibold text-fg after:absolute after:inset-x-2 after:bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-fg after:transition-transform after:duration-200 after:ease-out hover:after:scale-x-100 disabled:opacity-50 disabled:hover:after:scale-x-0 motion-reduce:after:transition-none"}
      onClick={() => {
        setPending(true);
        onError(null);
        void downloadSavedGenerationJson({
          url: generation.downloadUrl!,
          fileName: `${generation.id}.json`,
          expandedBytes: generation.expandedBytes,
        })
          .catch(() => onError("JSON could not be downloaded."))
          .finally(() => setPending(false));
      }}
    >
      {compact ? (
        <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 ${pending ? "animate-pulse motion-reduce:animate-none" : ""}`}>
          <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      ) : pending ? "Preparing…" : "Download JSON"}
    </button>
  );
}

function GenerationActions({
  generation,
  hasNickname,
  suspended,
  onUpdate,
  onRemove,
}: {
  generation: SavedGenerationPayload;
  hasNickname: boolean;
  suspended: boolean;
  onUpdate: (generation: SavedGenerationPayload) => void;
  onRemove: () => void;
}) {
  const router = useRouter();
  const [anonymous, setAnonymous] = useState(!hasNickname);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function cancel() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/generations/${encodeURIComponent(generation.id)}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error("Generation could not be stopped.");
      const detail = await fetch(`/api/generations/${encodeURIComponent(generation.id)}`, { cache: "no-store" });
      if (detail.ok) onUpdate(((await detail.json()) as { generation: SavedGenerationPayload }).generation);
    } catch {
      setMessage("Generation could not be stopped.");
    } finally {
      setPending(false);
    }
  }

  async function remove(acknowledgePublicExamples = false) {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/generations/${encodeURIComponent(generation.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledgePublicExamples }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: { publicExampleCount?: number } };
      } | null;
      if (response.status === 409 && body?.error?.code === "public_examples_require_confirmation" && !acknowledgePublicExamples) {
        const count = body.error.details?.publicExampleCount ?? 1;
        if (window.confirm(`Remove this generation and ${count} Gallery ${count === 1 ? "example" : "examples"}?`)) {
          setPending(false);
          await remove(true);
        }
        return;
      }
      if (!response.ok) throw new Error(body?.error?.message ?? "Generation could not be removed.");
      onRemove();
    } catch (removalError) {
      setMessage(removalError instanceof Error ? removalError.message : "Generation could not be removed.");
    } finally {
      setPending(false);
    }
  }

  async function submit() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/gallery/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: generation.id, postAnonymously: anonymous }),
      });
      const body = (await response.json()) as {
        created?: boolean;
        candidate?: { id: string };
        error?: { message?: string };
      };
      if (!response.ok || !body.candidate) throw new Error(body.error?.message ?? "Generation could not be submitted.");
      if (body.created === false) {
        const exampleResponse = await fetch(
          `/api/gallery/candidates/${encodeURIComponent(body.candidate.id)}/examples`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ generationId: generation.id, postAnonymously: anonymous }),
          },
        );
        const exampleBody = (await exampleResponse.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (!exampleResponse.ok) {
          throw new Error(exampleBody?.error?.message ?? "Example could not be added.");
        }
      }
      router.push(`/gallery/${body.candidate.id}`);
    } catch (submissionError) {
      setMessage(submissionError instanceof Error ? submissionError.message : "Generation could not be submitted.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(generation.status === "queued" || generation.status === "running") ? <button type="button" disabled={pending} className="mb-btn h-10" onClick={() => void cancel()}>Stop</button> : null}
        {generation.status === "succeeded" && !suspended ? <button type="button" disabled={pending || (!hasNickname && !anonymous)} className="mb-btn mb-btn-primary h-10" onClick={() => void submit()}>Add to Gallery</button> : null}
        <GenerationDownloadButton generation={generation} onError={setMessage} />
        <button type="button" disabled={pending} className="mb-btn h-10 text-muted hover:text-danger" onClick={() => void remove()}>Remove</button>
      </div>
      {generation.status === "succeeded" && !suspended ? <label className="flex min-h-10 items-center gap-2 text-xs text-muted"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />Post anonymously</label> : null}
      {message ? <p role="status" className="text-sm text-muted">{message}</p> : null}
    </div>
  );
}

function SavedBuildDialog({
  generation,
  onClose,
}: {
  generation: SavedGenerationPayload;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewerRef = useRef<VoxelViewerHandle>(null);
  const [build, setBuild] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (!generation.viewerUrl) {
      setLoading(false);
      setError("Viewer unavailable");
      return;
    }
    const controller = new AbortController();
    setBuild(null);
    setLoading(true);
    setError(null);
    void fetch(generation.viewerUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Viewer unavailable");
        return readBuildVariantPayload(response, {
          fallbackIdentity: {
            buildId: generation.id,
            variant: "full",
            checksum: generation.sha256,
          },
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
  }, [generation.id, generation.sha256, generation.viewerUrl]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="saved-build-dialog-title"
      className="mb-dialog m-auto w-[calc(100%-2rem)] max-w-3xl overflow-hidden rounded-md border-0 bg-card p-0 text-fg ring-1 ring-border-xl backdrop:bg-bg/60 backdrop:backdrop-blur-sm"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onClose={onClose}
    >
      <div className="flex max-h-[min(86vh,1060px)] flex-col">
        <header className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-3 sm:gap-3 sm:px-4">
          <div className="min-w-0">
            <p className="mb-eyebrow">Saved build</p>
            <h2 id="saved-build-dialog-title" className="mt-1 truncate text-lg font-semibold tracking-tight sm:text-xl">{generation.prompt}</h2>
          </div>
          <button type="button" autoFocus className="mb-btn mb-btn-ghost h-9 shrink-0 px-3 text-xs" onClick={onClose}>Close <span className="ml-1 mb-kbd">Esc</span></button>
        </header>
        <div className="min-h-0 overflow-y-auto px-4 py-4">
          <VoxelViewerCard
            title={generation.model.label}
            voxelBuild={build}
            expectedBlockCount={generation.blockCount ?? undefined}
            gridSize={generation.gridSize === 64 || generation.gridSize === 512 ? generation.gridSize : 256}
            palette={generation.palette === "advanced" ? "advanced" : "simple"}
            isLoading={loading}
            error={error ?? undefined}
            skipValidation
            enableBuildExport={Boolean(build)}
            exportLabel={generation.model.label}
            exportPrompt={generation.prompt}
            viewerRef={viewerRef}
            headerMeta={generation.expandedBytes != null ? `${formatBytes(generation.expandedBytes)} JSON` : undefined}
            actions={build && !loading ? (
              <>
                <GenerationDownloadButton generation={generation} compact onError={setDownloadError} />
                <SandboxGifExportButton
                  targets={[{
                    viewerRef,
                    modelName: generation.model.label,
                    company: "MineBench",
                    blockCount: generation.blockCount ?? 0,
                  }]}
                  promptText={generation.prompt}
                  cancelKey={`${generation.id}:${generation.sha256 ?? ""}`}
                  label="GIF"
                  embedded
                />
              </>
            ) : undefined}
          />
          {downloadError ? <p role="status" className="mt-2 px-1 text-sm text-danger">{downloadError}</p> : null}
        </div>
      </div>
    </dialog>
  );
}

export function GalleryYours({
  initialItems,
  initialCursor,
  hasNickname,
  suspended,
}: {
  initialItems: SavedGenerationPayload[];
  initialCursor: string | null;
  hasNickname: boolean;
  suspended: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (!items.some((item) => item.status === "queued" || item.status === "running")) return;
    const timer = window.setInterval(() => {
      void Promise.all(items.filter((item) => item.status === "queued" || item.status === "running").map(async (item) => {
        const response = await fetch(`/api/generations/${encodeURIComponent(item.id)}`, { cache: "no-store" });
        return response.ok ? ((await response.json()) as { generation: SavedGenerationPayload }).generation : item;
      })).then((updates) => {
        const byId = new Map(updates.map((item) => [item.id, item]));
        setItems((current) => current.map((item) => byId.get(item.id) ?? item));
      }).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [items]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/generations?cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Saved generations unavailable");
      const page = (await response.json()) as { items: SavedGenerationPayload[]; nextCursor: string | null };
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setLoadError("Saved generations unavailable");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section id="builds" className="scroll-mt-24" aria-labelledby="saved-builds-title">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="mb-eyebrow">Builds</p><h2 id="saved-builds-title" className="mt-2 text-xl font-semibold tracking-tight text-fg">Saved builds</h2></div>
        <div className="flex gap-2"><Link href="/gallery" className="mb-btn h-11">Explore</Link><Link href="/sandbox?mode=live" className="mb-btn mb-btn-primary h-11">Generate</Link></div>
      </header>
      {suspended ? <div className="mt-6 rounded-md border border-danger/40 bg-danger/5 px-4 py-3"><p className="font-semibold text-fg">Gallery access suspended</p><p className="mt-1 text-sm text-muted">Your private builds remain available.</p></div> : null}

      <div className="mt-6 grid gap-4">
        {items.map((generation, index) => (
          <article id={generation.id} key={generation.id} className={`group/card scroll-mt-24 rounded-md border border-border/80 bg-card/10 p-4 transition-[border-color,background-color] hover:border-border hover:bg-card/20 motion-reduce:transition-none sm:p-5 mb-card-enter ${index % 2 === 1 ? "mb-card-enter-delay" : ""}`}>
            <button type="button" disabled={!generation.viewerUrl} aria-label={`View ${generation.prompt}`} className="group/open grid w-full gap-5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-default md:grid-cols-[11rem_minmax(0,1fr)]" onClick={() => setSelectedId(generation.id)}>
              {generation.thumbnailUrl ? <div className="relative aspect-[4/3] overflow-hidden rounded bg-bg/55"><Image src={generation.thumbnailUrl} alt="" fill unoptimized sizes="11rem" className={`object-contain p-1.5 motion-reduce:transition-none ${generation.viewerUrl ? "transition-transform duration-300 ease-out group-hover/open:scale-[1.025]" : ""}`} /></div> : <div className="grid aspect-[4/3] rounded bg-bg/55 text-center text-sm text-muted"><span className="self-center"><span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full bg-current ${(generation.status === "queued" || generation.status === "running") ? "animate-pulse motion-reduce:animate-none" : ""}`} />{statusLabel(generation.status)}</span></div>}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted"><span>{statusLabel(generation.status)}</span><span>{generation.model.label}</span><time dateTime={generation.createdAt}>{new Date(generation.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</time></div>
                <h3 className={`mt-2 text-xl font-semibold leading-snug text-fg motion-reduce:transition-none ${generation.viewerUrl ? "transition-colors group-hover/open:text-accent" : ""}`}>{generation.prompt}</h3>
                {generation.error ? <p className="mt-2 text-sm text-danger">{generation.error.message}</p> : null}
                {generation.status === "succeeded" ? <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">{generation.blockCount != null ? <span>{generation.blockCount.toLocaleString()} blocks</span> : null}{generation.expandedBytes != null ? <span>{formatBytes(generation.expandedBytes)} JSON</span> : null}</div> : null}
              </div>
            </button>
            <div className="mt-5 md:ml-48"><GenerationActions generation={generation} hasNickname={hasNickname} suspended={suspended} onUpdate={(next) => setItems((current) => current.map((item) => item.id === next.id ? next : item))} onRemove={() => setItems((current) => current.filter((item) => item.id !== generation.id))} /></div>
          </article>
        ))}
        {items.length === 0 ? <div className="rounded-md border border-border/80 px-5 py-12 text-center"><p className="text-sm text-muted">No saved builds.</p></div> : null}
      </div>
      {cursor ? <div className="mt-12 flex justify-center"><button type="button" disabled={loadingMore} className="mb-btn h-11 min-w-36" onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "More"}</button></div> : null}
      {loadError ? <p role="status" className="mt-6 text-center text-sm text-danger">{loadError}</p> : null}
      {selected ? <SavedBuildDialog generation={selected} onClose={() => setSelectedId(null)} /> : null}
    </section>
  );
}
