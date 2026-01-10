"use client";

import { useEffect, useState } from "react";
import { HiddenPill } from "./HiddenPill";

export function ModelReveal({
  revealed,
  provider,
  modelName,
}: {
  revealed: boolean;
  provider?: string;
  modelName?: string;
}) {
  const [showRevealed, setShowRevealed] = useState(false);

  useEffect(() => {
    if (revealed) {
      // tiny delay so pill exit animation can start first
      const t = setTimeout(() => setShowRevealed(true), 80);
      return () => clearTimeout(t);
    } else {
      setShowRevealed(false);
    }
  }, [revealed]);

  if (!revealed) {
    return <HiddenPill />;
  }

  return (
    <span className={`mb-model-reveal ${showRevealed ? "mb-model-reveal-in" : ""}`}>
      {provider && modelName ? (
        <>
          <span className="text-muted">{provider}</span>
          <span className="mx-1.5 text-muted/50">•</span>
          <span className="text-fg font-medium">{modelName}</span>
        </>
      ) : (
        <span className="text-muted">—</span>
      )}
    </span>
  );
}
