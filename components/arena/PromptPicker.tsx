"use client";

import { useCallback, useEffect, useState } from "react";
import type { PromptListResponse } from "@/lib/arena/types";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

export function PromptPicker({
  selectedPromptId,
  onChangePromptId,
}: {
  selectedPromptId?: string;
  onChangePromptId: (id: string) => void;
}) {
  const [prompts, setPrompts] = useState<PromptListResponse["prompts"]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setStatus("loading");
    setError(null);
    fetchWithRetry("/api/arena/prompts", {
      method: "GET",
      parentSignal: controller.signal,
      timeoutMs: 10_000,
      retries: 2,
    })
      .then(async (r) => (await r.json()) as PromptListResponse)
      .then((data: PromptListResponse) => {
        if (cancelled) return;
        setPrompts(data.prompts);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setPrompts([]);
        setStatus("error");
        setError(e instanceof Error ? e.message : "Failed to load prompts");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadToken]);

  const handleRetry = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  return (
    <label className="flex min-w-64 flex-col gap-1">
      <div className="text-xs font-medium text-muted">Prompt</div>
      <div className="relative">
        <select
          className="mb-field h-10 w-full appearance-none pr-10"
          value={selectedPromptId ?? ""}
          onChange={(e) => onChangePromptId(e.target.value)}
        >
          {status === "loading" ? (
            <option value="" disabled>
              Loading prompts…
            </option>
          ) : null}
          {status !== "loading" && prompts.length === 0 ? (
            <option value="" disabled>
              {status === "error" ? "Failed to load prompts" : "No prompts (seed required)"}
            </option>
          ) : null}
          {prompts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.text}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="m7 10 5 5 5-5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      </div>
      {status === "error" && error ? (
        <div className="flex items-center justify-between gap-2 text-xs text-danger">
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="shrink-0 rounded-full px-2 py-0.5 font-medium text-danger ring-1 ring-danger/30 transition hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-danger/60"
          >
            Retry
          </button>
        </div>
      ) : null}
    </label>
  );
}
