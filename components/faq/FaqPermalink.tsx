"use client";

import { useEffect, useRef, useState } from "react";

const COPIED_DURATION_MS = 1400;

export function FaqPermalink({ id, question }: { id: string; question: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  function copyLink() {
    const url = new URL(window.location.href);
    url.hash = id;

    void navigator.clipboard
      .writeText(url.toString())
      .then(() => {
        setCopied(true);
        if (resetTimer.current) window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(
          () => setCopied(false),
          COPIED_DURATION_MS,
        );
      })
      .catch(() => {});
  }

  return (
    <a
      aria-label={copied ? `Copied link to “${question}”` : `Copy link to “${question}”`}
      className="group -mr-2 grid h-11 w-11 shrink-0 place-items-center text-lg text-muted2 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:mr-0"
      href={`#${id}`}
      onClick={copyLink}
      title={copied ? "Copied" : "Copy link"}
    >
      <span
        aria-hidden="true"
        className={`transition-[color,text-shadow,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-110 group-hover:[text-shadow:0_0_4px_hsl(var(--accent)/0.8),0_0_14px_hsl(var(--accent)/0.55)] group-focus-visible:scale-110 group-focus-visible:text-accent group-focus-visible:[text-shadow:0_0_4px_hsl(var(--accent)/0.8),0_0_14px_hsl(var(--accent)/0.55)] motion-reduce:transform-none motion-reduce:transition-none ${
          copied
            ? "scale-110 text-accent [text-shadow:0_0_4px_hsl(var(--accent)/0.8),0_0_14px_hsl(var(--accent)/0.55)]"
            : ""
        }`}
      >
        #
      </span>
      <span aria-live="polite" className="sr-only" role="status">
        {copied ? "Link copied" : ""}
      </span>
    </a>
  );
}
