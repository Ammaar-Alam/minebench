"use client";

import Link from "next/link";
import { useState } from "react";
import { publishGenerationToGallery } from "@/lib/gallery/client";

export function GenerationGalleryButton({
  generationId,
  postAnonymously,
  onError,
  compact = false,
}: {
  generationId: string;
  postAnonymously: boolean;
  onError: (message: string | null) => void;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);

  if (candidateId) {
    return <Link href={`/gallery/${candidateId}`} className={`mb-btn mb-btn-ghost px-3 text-accent ${compact ? "h-8 text-xs" : "h-11 text-sm"}`}>Gallery</Link>;
  }

  return (
    <button
      type="button"
      disabled={pending}
      className={`mb-btn mb-btn-primary px-3 ${compact ? "h-8 text-xs" : "h-11 text-sm"}`}
      onClick={() => {
        setPending(true);
        onError(null);
        void publishGenerationToGallery(generationId, postAnonymously)
          .then(setCandidateId)
          .catch((error) => onError(error instanceof Error ? error.message : "Generation could not be submitted."))
          .finally(() => setPending(false));
      }}
    >
      {pending ? "Adding…" : <><span className="sm:hidden">Add</span><span className="hidden sm:inline">Add to Gallery</span></>}
    </button>
  );
}
