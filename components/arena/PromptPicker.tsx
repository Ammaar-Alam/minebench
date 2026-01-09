"use client";

import { useEffect, useState } from "react";
import type { PromptListResponse } from "@/lib/arena/types";

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

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    fetch("/api/arena/prompts", { method: "GET" })
      .then(async (r) => {
        if (r.ok) return (await r.json()) as PromptListResponse;
        const text = await r.text().catch(() => "");
        throw new Error(text || `Failed to load prompts (${r.status})`);
      })
      .then((data: PromptListResponse) => {
        if (cancelled) return;
        setPrompts(data.prompts);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPrompts([]);
        setStatus("error");
        setError(e instanceof Error ? e.message : "Failed to load prompts");
      });
    return () => {
      cancelled = true;
    };
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
        <div className="text-xs text-danger">
          {error}
        </div>
      ) : null}
    </label>
  );
}
