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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/arena/prompts", { method: "GET" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed prompts"))))
      .then((data: PromptListResponse) => {
        if (cancelled) return;
        setPrompts(data.prompts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <label className="flex flex-col gap-1">
      <div className="text-xs font-medium text-muted">Prompt</div>
      <select
        className="h-10 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg outline-none ring-accent/40 transition focus:ring-2"
        value={selectedPromptId ?? ""}
        onChange={(e) => onChangePromptId(e.target.value)}
      >
        {prompts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.text}
          </option>
        ))}
      </select>
    </label>
  );
}

