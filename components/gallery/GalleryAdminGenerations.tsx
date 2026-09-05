"use client";

import { useEffect, useState } from "react";
import { SavedBuildDialog } from "@/components/gallery/GalleryYours";
import { formatBuildDuration } from "@/lib/buildMetrics";
import type { listAdminGenerations } from "@/lib/generations/service";

type Page = Awaited<ReturnType<typeof listAdminGenerations>>;
const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function GalleryAdminGenerations({
  ownerId,
  refreshedAt,
  onPublish,
}: {
  ownerId?: string;
  refreshedAt?: string;
  onPublish: (publicId: string) => Promise<boolean>;
}) {
  const [page, setPage] = useState<Page>({ items: [], nextCursor: null });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageCount, setPageCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Page["items"][number] | null>(null);
  const [previewedIds, setPreviewedIds] = useState<Set<string>>(() => new Set());
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishMessage, setPublishMessage] = useState<{ id: string; text: string } | null>(null);
  const [reload, setReload] = useState(0);
  const params = new URLSearchParams({ query, active: String(active), ...(ownerId ? { ownerId } : {}) }).toString();

  useEffect(() => {
    setPageCount(1);
    setPage({ items: [], nextCursor: null });
    setLoading(true);
    setError(null);
  }, [params]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void (async () => {
        const items: Page["items"] = [];
        let nextCursor: string | null = null;
        for (let index = 0; index < pageCount; index += 1) {
          const cursor = nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : "";
          const response = await fetch(`/api/admin/generations?${params}${cursor}`, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Generations unavailable.");
          const next = await response.json() as Page;
          items.push(...next.items);
          nextCursor = next.nextCursor;
          if (!nextCursor) break;
        }
        if (!controller.signal.aborted) setPage({ items, nextCursor });
      })()
        .catch(() => { if (!controller.signal.aborted) setError("Generations unavailable."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [params, refreshedAt, reload, pageCount]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") setReload((value) => value + 1);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  function viewGeneration(generation: Page["items"][number]) {
    if (generation.canPublish) {
      setPreviewedIds((current) => new Set(current).add(generation.id));
    }
    setSelected(generation);
  }

  async function publishGeneration(generation: Page["items"][number]) {
    if (!window.confirm("Publish this build anonymously to Gallery? Confirm the prompt and build contain no personal or sensitive information.")) return;
    setPublishingId(generation.id);
    setPublishMessage(null);
    try {
      const ok = await onPublish(generation.id);
      if (!ok) throw new Error("Build could not be published.");
      setPage((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === generation.id ? { ...item, published: true, canPublish: false } : item
        ),
      }));
      setPublishMessage({ id: generation.id, text: "Published anonymously." });
      setReload((value) => value + 1);
    } catch {
      setPublishMessage({ id: generation.id, text: "Build could not be published." });
    } finally {
      setPublishingId(null);
    }
  }


  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col lg:h-full" aria-label="Generations" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          {([false, true] as const).map((value) => (
            <button key={String(value)} type="button" aria-pressed={active === value} onClick={() => setActive(value)} className={`min-h-10 text-sm ${active === value ? "font-semibold text-fg" : "text-muted hover:text-fg"}`}>
              {value ? "Active" : "All"}
            </button>
          ))}
        </div>
        <label className="w-full sm:w-64">
          <span className="sr-only">Search generations</span>
          <input className="mb-field h-9" type="search" placeholder="Search generations" maxLength={800} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      {error ? <div role="status" className="flex items-center gap-3 py-3 text-sm text-danger">{error}<button type="button" className="mb-btn h-9" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : null}
      <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto px-1" aria-label="Generation results">
        {page.items.map((generation) => (
          <article key={generation.id} className="space-y-2 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium text-fg [overflow-wrap:anywhere]">{generation.prompt}</p>
              <div className="flex shrink-0 flex-wrap gap-2">
                {generation.viewerUrl ? <button type="button" className="mb-btn h-9 text-xs" onClick={() => viewGeneration(generation)}>View build</button> : null}
                {generation.canPublish && previewedIds.has(generation.id) ? (
                  <button type="button" disabled={publishingId === generation.id} className="mb-btn mb-btn-primary h-9 text-xs" onClick={() => void publishGeneration(generation)}>
                    {publishingId === generation.id ? "Publishing…" : "Publish anonymously"}
                  </button>
                ) : null}
              </div>
            </div>
            <p className="break-all text-xs text-muted">{generation.owner?.email ?? "Guest"}{generation.owner?.publicNickname ? ` · ${generation.owner.publicNickname}` : ""}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              <span className="font-medium text-fg">{generation.model.label}</span>
              <span className={generation.status === "failed" ? "text-danger" : generation.status === "running" || generation.status === "queued" ? "text-accent" : ""}>
                {generation.status === "succeeded" ? "Ready" : generation.status === "running" ? "Generating" : generation.status === "queued" ? "Queued" : generation.status === "failed" ? "Failed" : "Canceled"}
              </span>
              <span>{generation.published ? "Published" : "Unpublished"}</span>
              {generation.generationTimeMs != null ? <span>{formatBuildDuration(generation.generationTimeMs)}</span> : null}
              <time dateTime={generation.createdAt}>{dateTime.format(new Date(generation.createdAt))}</time>
            </div>
            {generation.error ? <p className="break-words text-xs text-danger">{generation.error.message}</p> : null}
            {publishMessage?.id === generation.id ? <p role="status" className="text-xs text-muted">{publishMessage.text}</p> : null}
          </article>
        ))}
        {page.items.length === 0 ? <p className="py-8 text-sm text-muted">{loading ? "Loading generations…" : "No matching generations"}</p> : null}
        {page.nextCursor ? <div className="py-3"><button type="button" className="mb-btn h-10" disabled={loading} onClick={() => setPageCount((value) => value + 1)}>{loading ? "Loading…" : "Load more"}</button></div> : null}
      </div>
      {selected ? <SavedBuildDialog generation={selected} onClose={() => setSelected(null)} onExplorerExit={() => setSelected(null)} /> : null}
    </section>
  );
}
