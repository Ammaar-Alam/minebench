"use client";

import Link from "next/link";
import { useState } from "react";
import { publishGenerationToGallery } from "@/lib/gallery/client";

export function GenerationGalleryButton({
  generationId,
  postAnonymously,
  canChooseAttribution = false,
  onError,
  compact = false,
}: {
  generationId: string;
  postAnonymously: boolean;
  canChooseAttribution?: boolean;
  onError: (message: string | null) => void;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [anonymous, setAnonymous] = useState(postAnonymously);

  if (candidateId) {
    return <Link href={`/gallery/${candidateId}`} className={`mb-btn mb-btn-ghost px-3 text-accent ${compact ? "h-8 text-xs" : "h-11 text-sm"}`}>Gallery</Link>;
  }

  const button = (
    <button
      type="button"
      disabled={pending}
      className={`mb-btn mb-btn-primary px-3 ${compact ? "h-8 text-xs" : "h-11 text-sm"}`}
      onClick={() => {
        setPending(true);
        onError(null);
        void publishGenerationToGallery(generationId, anonymous)
          .then(setCandidateId)
          .catch((error) => onError(error instanceof Error ? error.message : "Generation could not be submitted."))
          .finally(() => setPending(false));
      }}
    >
      {pending ? "Adding…" : <><span className="sm:hidden">Add</span><span className="hidden sm:inline">Add to Gallery</span></>}
    </button>
  );

  if (!canChooseAttribution) return button;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {button}
      <label className={`flex items-center gap-1.5 text-muted ${compact ? "min-h-8 text-[11px]" : "min-h-11 text-xs"}`}>
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent"
          checked={anonymous}
          disabled={pending}
          onChange={(event) => setAnonymous(event.target.checked)}
        />
        Anonymous
      </label>
    </div>
  );
}
