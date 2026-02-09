"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function AnimatedPrompt({
  text,
  isExpanded,
}: {
  text: string;
  isExpanded: boolean;
}) {
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(true);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const lastTextRef = useRef<string>("");

  const reduced = useMemo(() => prefersReducedMotion(), []);

  useEffect(() => {
    const next = text ?? "";
    if (lastTextRef.current === next) return;
    lastTextRef.current = next;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // Long prompts read better without character-by-character animation.
    if (!next || reduced || next.length > 180) {
      setShown(next);
      setDone(true);
      return;
    }

    setShown("");
    setDone(false);
    startRef.current = performance.now();

    // duration scales with length but stays snappy
    const durationMs = clamp(520 + next.length * 8, 650, 1400);

    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const t = clamp(elapsed / durationMs, 0, 1);
      // smooth-ish: easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const count = clamp(Math.floor(next.length * eased), 0, next.length);
      setShown(next.slice(0, count));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        setDone(true);
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [text, reduced]);

  // if user expands, don't make them wait
  useEffect(() => {
    if (!isExpanded) return;
    if (done) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setShown(text);
    setDone(true);
  }, [isExpanded, done, text]);

  return (
    <div className="relative">
      <span>{shown}</span>
      {/* caret only while typing or shortly after completion */}
      {!reduced ? (
        <span
          aria-hidden="true"
          className={`mb-caret ${done ? "mb-caret-idle" : ""}`}
        />
      ) : null}
    </div>
  );
}
