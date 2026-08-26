"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { SavedGenerationPayload } from "@/lib/generations/service";

function bytes(value: number | null): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(value: SavedGenerationPayload["status"]): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
        if (!window.confirm("This prompt is already in Gallery. Add this generation as an example?")) {
          setPending(false);
          return;
        }
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
      window.location.assign(`/gallery/${body.candidate.id}`);
    } catch (submissionError) {
      setMessage(submissionError instanceof Error ? submissionError.message : "Generation could not be submitted.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(generation.status === "queued" || generation.status === "running") ? <button type="button" disabled={pending} className="mb-btn h-10" onClick={() => void cancel()}>Stop</button> : null}
        {generation.status === "succeeded" && !suspended ? <button type="button" disabled={pending || (!hasNickname && !anonymous)} className="mb-btn mb-btn-primary h-10" onClick={() => void submit()}>Submit</button> : null}
        {generation.downloadUrl ? <a className="mb-btn h-10" href={generation.downloadUrl}>Download JSON</a> : null}
        <button type="button" disabled={pending} className="mb-btn h-10 text-muted hover:text-danger" onClick={() => void remove()}>Remove</button>
      </div>
      {generation.status === "succeeded" && !suspended ? <label className="flex min-h-10 items-center gap-2 text-xs text-muted"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />Post anonymously</label> : null}
      {message ? <p role="status" className="text-sm text-muted">{message}</p> : null}
    </div>
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
    <div className="mx-auto w-full max-w-6xl py-4 sm:py-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div><Link href="/gallery" className="mb-eyebrow hover:text-fg">Gallery</Link><h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Yours</h1></div>
        <div className="flex gap-2"><Link href="/gallery" className="mb-btn h-11">Explore</Link><Link href="/sandbox?mode=live" className="mb-btn mb-btn-primary h-11">Generate</Link></div>
      </header>
      {suspended ? <div className="mt-10 border-l-2 border-danger pl-4"><p className="font-semibold text-fg">Account suspended</p><p className="mt-1 text-sm text-muted">Private generations remain available.</p></div> : null}

      <div className="mt-10 divide-y divide-border/70">
        {items.map((generation) => (
          <article key={generation.id} className="grid gap-6 py-6 lg:grid-cols-[14rem_minmax(0,1fr)_auto] lg:items-start">
            {generation.thumbnailUrl ? <div className="relative aspect-[4/3] border border-border bg-bg"><Image src={generation.thumbnailUrl} alt="" fill unoptimized sizes="14rem" className="object-contain p-3" /></div> : <div className="grid aspect-[4/3] border border-border bg-bg text-center text-sm text-muted"><span className="self-center">{statusLabel(generation.status)}</span></div>}
            <div className="min-w-0 space-y-4">
              <div><div className="flex flex-wrap items-center gap-3 text-xs text-muted"><span>{statusLabel(generation.status)}</span><span>{generation.model.label}</span></div><h2 className="mt-2 text-xl font-semibold leading-snug text-fg">{generation.prompt}</h2>{generation.error ? <p className="mt-2 text-sm text-danger">{generation.error.message}</p> : null}</div>
              {generation.status === "succeeded" ? <dl className="grid gap-x-5 gap-y-3 text-xs sm:grid-cols-3"><div><dt className="text-muted">Blocks</dt><dd className="mt-1 text-fg">{generation.blockCount?.toLocaleString() ?? "—"}</dd></div><div><dt className="text-muted">Expanded JSON</dt><dd className="mt-1 text-fg">{bytes(generation.expandedBytes)}</dd></div><div><dt className="text-muted">Stored</dt><dd className="mt-1 text-fg">{bytes(generation.storedBytes)}</dd></div></dl> : null}
              {generation.sha256 ? <p className="break-all font-mono text-[11px] leading-5 text-muted">SHA-256 {generation.sha256}</p> : null}
            </div>
            <GenerationActions generation={generation} hasNickname={hasNickname} suspended={suspended} onUpdate={(next) => setItems((current) => current.map((item) => item.id === next.id ? next : item))} onRemove={() => setItems((current) => current.filter((item) => item.id !== generation.id))} />
          </article>
        ))}
        {items.length === 0 ? <div className="py-14 sm:py-20"><p className="font-display text-xl font-semibold tracking-tight text-muted sm:text-2xl">Nothing saved.</p></div> : null}
      </div>
      {cursor ? <div className="mt-12 flex justify-center"><button type="button" disabled={loadingMore} className="mb-btn h-11 min-w-36" onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "More"}</button></div> : null}
      {loadError ? <p role="status" className="mt-6 text-center text-sm text-danger">{loadError}</p> : null}
    </div>
  );
}
