"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GalleryCandidatePayload } from "@/lib/gallery/service";
import { GalleryVoteButton } from "@/components/gallery/GalleryVoteButton";

function SubmissionDialog({
  open,
  hasNickname,
  onClose,
}: {
  open: boolean;
  hasNickname: boolean;
  onClose: () => void;
}) {
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
      window.location.assign(`/gallery/${body.candidate.id}`);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Prompt could not be submitted.");
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="submit-prompt-title"
      className="m-auto w-[min(36rem,calc(100%-2rem))] border border-border bg-bg p-0 text-fg backdrop:bg-black/55"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-6 p-6 sm:p-7">
        <div>
          <p className="mb-eyebrow">Gallery</p>
          <h2 id="submit-prompt-title" className="mt-2 text-2xl font-semibold tracking-tight">Submit prompt</h2>
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
          <button type="submit" disabled={pending || (!hasNickname && !anonymous)} className="mb-btn mb-btn-primary h-11">{pending ? "Submitting…" : "Submit"}</button>
          <button type="button" className="mb-btn h-11" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

function GalleryCard({ candidate, featured }: { candidate: GalleryCandidatePayload; featured: boolean }) {
  return (
    <article className={`group min-w-0 ${featured ? "md:col-span-2" : ""}`}>
      <Link href={`/gallery/${candidate.id}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50">
        {candidate.cover?.previewUrl ? (
          <div className={`relative overflow-hidden border border-border/70 bg-card/15 ${featured ? "aspect-[16/7]" : "aspect-[4/3]"}`}>
            <Image
              src={candidate.cover.previewUrl}
              alt={`Preview of ${candidate.prompt}`}
              fill
              unoptimized
              sizes={featured ? "(min-width: 768px) 66vw, 100vw" : "(min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw"}
              className="object-contain p-5 transition-transform duration-300 ease-out group-hover:scale-[1.015] motion-reduce:transition-none"
            />
          </div>
        ) : null}
        <div className={`space-y-3 ${candidate.cover?.previewUrl ? "pt-4" : "border-t border-border/70 py-7 sm:py-9"}`}>
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>{candidate.attribution}</span>
            {candidate.selected ? <span className="font-medium uppercase tracking-[0.12em] text-accent">Selected</span> : null}
          </div>
          <h2 className={`${featured ? "text-2xl sm:text-3xl" : "text-xl"} text-balance font-semibold leading-snug tracking-tight text-fg transition-colors group-hover:text-accent motion-reduce:transition-none`}>{candidate.prompt}</h2>
          {candidate.cover ? <p className="truncate text-sm text-muted">{candidate.cover.model.label}</p> : null}
        </div>
      </Link>
      <div className="mt-2 flex items-center justify-between">
        <GalleryVoteButton candidateId={candidate.id} initialCount={candidate.upvoteCount} initialUpvoted={candidate.upvoted} />
        <Link href={`/sandbox?mode=live&prompt=${encodeURIComponent(candidate.prompt)}`} className="inline-flex min-h-11 items-center px-2 text-sm text-muted hover:text-fg">Use prompt</Link>
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
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/gallery/candidates?sort=${sort}&cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
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
    <div className="mx-auto w-full max-w-7xl py-4 sm:py-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Gallery</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={signedIn ? "/gallery/yours" : "/sign-in?next=/gallery/yours"} className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-muted hover:text-fg">Yours</Link>
          {signedIn && !suspended ? (
            <button type="button" className="mb-btn mb-btn-primary h-11" onClick={() => setSubmitOpen(true)}>Submit prompt</button>
          ) : !signedIn ? (
            <Link href="/sign-in?next=/gallery" className="mb-btn mb-btn-primary h-11">Sign in</Link>
          ) : null}
        </div>
      </header>

      <nav className="mt-10 flex items-center gap-7" aria-label="Gallery sorting">
        <Link href="/gallery" aria-current={sort === "top" ? "page" : undefined} className={`inline-flex min-h-11 items-center text-sm ${sort === "top" ? "font-semibold text-fg" : "text-muted hover:text-fg"}`}>Top</Link>
        <Link href="/gallery?sort=new" aria-current={sort === "new" ? "page" : undefined} className={`inline-flex min-h-11 items-center text-sm ${sort === "new" ? "font-semibold text-fg" : "text-muted hover:text-fg"}`}>New</Link>
      </nav>

      {items.length ? (
        <div className="mt-7 grid grid-cols-1 gap-x-5 gap-y-12 md:grid-cols-2 xl:grid-cols-3">
          {items.map((candidate, index) => <GalleryCard key={candidate.id} candidate={candidate} featured={index === 0} />)}
        </div>
      ) : (
        <section className="mt-14 py-10 sm:mt-20 sm:py-14" aria-labelledby="empty-gallery-title">
          <h2 id="empty-gallery-title" className="font-display text-xl font-semibold tracking-tight text-muted sm:text-2xl">No prompts yet.</h2>
        </section>
      )}

      {cursor ? <div className="mt-12 flex justify-center"><button type="button" className="mb-btn h-11 min-w-36" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "More"}</button></div> : null}
      {loadError ? <p role="status" className="mt-6 text-center text-sm text-danger">{loadError}</p> : null}
      <SubmissionDialog open={submitOpen} hasNickname={hasNickname} onClose={() => setSubmitOpen(false)} />
    </div>
  );
}
