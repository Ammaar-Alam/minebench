"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { GalleryCandidatePayload } from "@/lib/gallery/service";
import { GalleryVoteButton } from "@/components/gallery/GalleryVoteButton";
import { VoxelEmptyState } from "@/components/voxel/VoxelEmptyState";

function SubmissionDialog({
  open,
  hasNickname,
  onClose,
}: {
  open: boolean;
  hasNickname: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState("");
  const [anonymous, setAnonymous] = useState(!hasNickname);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
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
      const response = await fetch("/api/gallery/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, postAnonymously: anonymous }),
      });
      const body = (await response.json()) as {
        candidate?: { id: string };
        error?: { message?: string };
      };
      if (!response.ok || !body.candidate) throw new Error(body.error?.message ?? "Prompt could not be submitted.");
      router.push(`/gallery/${body.candidate.id}`);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Prompt could not be submitted.");
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="submit-prompt-title"
      className="mb-dialog m-auto w-[min(36rem,calc(100%-2rem))] rounded-md border border-border bg-bg p-0 text-fg backdrop:bg-black/55"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-6 p-6 sm:p-7">
        <div>
          <p className="mb-eyebrow">Gallery</p>
          <h2 id="submit-prompt-title" className="mt-2 text-2xl font-semibold tracking-tight">Add prompt</h2>
        </div>
        <label className="block space-y-2">
          <span className="text-sm font-medium">Prompt</span>
          <textarea className="mb-field min-h-32 w-full resize-y py-3" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={800} required autoFocus />
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm text-muted">
          <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />
          Post anonymously
        </label>
        {!hasNickname && !anonymous ? <p className="text-sm text-muted">Choose a public name in Account.</p> : null}
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="submit" disabled={pending || (!hasNickname && !anonymous)} className="mb-btn mb-btn-primary h-11">{pending ? "Adding…" : "Add"}</button>
          <button type="button" className="mb-btn h-11" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

function GalleryCard({ candidate, delayed }: { candidate: GalleryCandidatePayload; delayed: boolean }) {
  return (
    <article className={`group flex min-w-0 flex-col overflow-hidden rounded-md border border-border/80 bg-card/10 transition-[transform,border-color,background-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/35 hover:bg-card/20 hover:shadow-soft active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none mb-card-enter ${delayed ? "mb-card-enter-delay" : ""}`}>
      <Link href={`/gallery/${candidate.id}`} className="flex flex-1 flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50">
        {candidate.cover?.previewUrl ? (
          <div className="relative aspect-[4/3] overflow-hidden bg-bg/45">
            <Image
              src={candidate.cover.previewUrl}
              alt=""
              fill
              unoptimized
              sizes="(min-width: 1536px) 25vw, (min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw"
              className="object-contain p-2 transition-transform duration-300 ease-out group-hover:scale-[1.025] motion-reduce:transition-none"
            />
          </div>
        ) : <div className="relative aspect-[4/3] bg-bg/45"><VoxelEmptyState /></div>}
        <div className="flex flex-1 flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>{candidate.attribution}</span>
            {candidate.selected ? <span className="font-medium uppercase tracking-[0.12em] text-accent">Selected</span> : null}
          </div>
          <h2 className="line-clamp-3 text-balance text-xl font-semibold leading-snug tracking-tight text-fg transition-colors group-hover:text-accent motion-reduce:transition-none">{candidate.prompt}</h2>
          {candidate.cover ? <p className="mt-auto truncate pt-3 text-sm text-muted">{candidate.cover.model.label}</p> : null}
        </div>
      </Link>
      <div className="flex items-center justify-between px-3 pb-2">
        <GalleryVoteButton candidateId={candidate.id} initialCount={candidate.upvoteCount} initialUpvoted={candidate.upvoted} />
        <Link href={`/sandbox?mode=live&prompt=${encodeURIComponent(candidate.prompt)}`} className="inline-flex min-h-11 items-center px-2 text-sm text-muted transition-colors hover:text-fg motion-reduce:transition-none">Use prompt</Link>
      </div>
    </article>
  );
}

export function GalleryExplore({
  initialItems,
  initialCursor,
  sort,
  signedIn,
  hasNickname,
  suspended,
}: {
  initialItems: GalleryCandidatePayload[];
  initialCursor: string | null;
  sort: "top" | "new";
  signedIn: boolean;
  hasNickname: boolean;
  suspended: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [activeSort, setActiveSort] = useState(sort);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  useEffect(() => {
    setItems(initialItems);
    setCursor(initialCursor);
    setActiveSort(sort);
  }, [initialCursor, initialItems, sort]);

  async function changeSort(nextSort: "top" | "new") {
    if (nextSort === activeSort || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/gallery/candidates?sort=${nextSort}`, { cache: "no-store" });
      const page = (await response.json()) as { items: GalleryCandidatePayload[]; nextCursor: string | null };
      if (!response.ok) throw new Error("Gallery unavailable");
      setItems(page.items);
      setCursor(page.nextCursor);
      setActiveSort(nextSort);
      window.history.replaceState(window.history.state, "", nextSort === "new" ? "/gallery?sort=new" : "/gallery");
    } catch {
      setLoadError("Gallery unavailable");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/gallery/candidates?sort=${activeSort}&cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      const page = (await response.json()) as { items: GalleryCandidatePayload[]; nextCursor: string | null };
      if (!response.ok) throw new Error("Gallery unavailable");
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setLoadError("Gallery unavailable");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-fade-in mx-auto w-full max-w-7xl py-4 sm:py-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Gallery</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={signedIn ? "/account#builds" : "/sign-in?next=/account"} className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-muted transition-colors hover:text-fg motion-reduce:transition-none">Builds</Link>
          {signedIn && !suspended ? (
            <button type="button" className="mb-btn mb-btn-primary h-11" onClick={() => setSubmitOpen(true)}>Add prompt</button>
          ) : !signedIn ? (
            <Link href="/sign-in?next=/gallery" className="mb-btn mb-btn-primary h-11">Sign in</Link>
          ) : null}
        </div>
      </header>

      <nav className="mt-10 flex items-center gap-7" aria-label="Gallery sorting">
        {(["top", "new"] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={loading}
            aria-current={activeSort === option ? "page" : undefined}
            className={`relative inline-flex min-h-11 items-center text-sm capitalize transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-left after:bg-fg after:transition-transform after:duration-200 after:ease-out motion-reduce:transition-none motion-reduce:after:transition-none ${activeSort === option ? "font-semibold text-fg after:scale-x-100" : "text-muted after:scale-x-0 hover:text-fg"}`}
            onClick={() => void changeSort(option)}
          >
            {option}
          </button>
        ))}
      </nav>

      <div key={activeSort} className="mb-fade-in">
        {items.length ? (
          <div className="mt-7 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {items.map((candidate, index) => <GalleryCard key={candidate.id} candidate={candidate} delayed={index % 2 === 1} />)}
          </div>
        ) : (
          <section className="mt-14 py-10 sm:mt-20 sm:py-14" aria-labelledby="empty-gallery-title">
            <h2 id="empty-gallery-title" className="font-display text-xl font-semibold tracking-tight text-muted sm:text-2xl">No prompts yet.</h2>
          </section>
        )}
      </div>

      {cursor ? <div className="mt-12 flex justify-center"><button type="button" className="mb-btn h-11 min-w-36" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "More"}</button></div> : null}
      {loadError ? <p role="status" className="mt-6 text-center text-sm text-danger">{loadError}</p> : null}
      <SubmissionDialog open={submitOpen} hasNickname={hasNickname} onClose={() => setSubmitOpen(false)} />
    </div>
  );
}
