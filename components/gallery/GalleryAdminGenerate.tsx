"use client";

import { useState } from "react";
import { previewGalleryGeneration, queueGalleryGeneration } from "@/app/admin/gallery/actions";

type Request = { candidatePublicId: string } | { modelKey: string };
type Preview = { builds: number; prompts: number; costUsd: number };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// preview the plan and its cost, then queue it on the worker
export function GalleryAdminGenerate({ request, label, disabled }: { request: Request; label: string; disabled?: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setStatus(null);
    try {
      await action();
    } catch {
      setStatus("Try again.");
    } finally {
      setPending(false);
    }
  }

  const loadPreview = () => run(async () => {
    const result = await previewGalleryGeneration(request);
    if (!result.ok) return setStatus(result.error);
    if (result.builds === 0) return setStatus("Nothing to generate");
    setPreview(result);
  });

  const queue = () => run(async () => {
    const result = await queueGalleryGeneration(request);
    setPreview(null);
    setStatus(result.ok ? `Queued ${result.queued}` : result.error);
  });

  if (preview) {
    const scope = preview.prompts > 1 ? ` across ${preview.prompts} prompts` : "";
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{preview.builds} {preview.builds === 1 ? "build" : "builds"}{scope} · {usd.format(preview.costUsd)}</span>
        <button type="button" className="mb-btn mb-btn-primary h-10" disabled={pending} onClick={() => void queue()}>{pending ? "Queuing…" : "Queue"}</button>
        <button type="button" className="mb-btn mb-btn-ghost h-10" disabled={pending} onClick={() => setPreview(null)}>Cancel</button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="mb-btn h-10" disabled={pending || disabled} onClick={() => void loadPreview()}>{pending ? "Checking…" : label}</button>
      {status ? <span role="status" className="text-xs text-muted">{status}</span> : null}
    </span>
  );
}
