"use client";

import { useEffect, useMemo, useState } from "react";
import { ArenaMatchup, VoteChoice } from "@/lib/arena/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { PromptPicker } from "@/components/arena/PromptPicker";
import { VoteBar } from "@/components/arena/VoteBar";

type ArenaState =
  | { kind: "loading" }
  | { kind: "ready"; matchup: ArenaMatchup }
  | { kind: "error"; message: string };

async function fetchMatchup(promptId?: string): Promise<ArenaMatchup> {
  const url = new URL("/api/arena/matchup", window.location.origin);
  if (promptId) url.searchParams.set("promptId", promptId);
  const res = await fetch(url, { method: "GET", credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ArenaMatchup;
}

async function submitVote(matchupId: string, choice: VoteChoice) {
  const res = await fetch("/api/arena/vote", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchupId, choice }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export function Arena() {
  const [state, setState] = useState<ArenaState>({ kind: "loading" });
  const [selectedPromptId, setSelectedPromptId] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const matchup = state.kind === "ready" ? state.matchup : null;

  const title = useMemo(() => {
    if (!matchup) return "Arena";
    return matchup.prompt.text;
  }, [matchup]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchMatchup(selectedPromptId)
      .then((m) => {
        if (cancelled) return;
        setSelectedPromptId(m.prompt.id);
        setState({ kind: "ready", matchup: m });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load matchup",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPromptId]);

  async function handleVote(choice: VoteChoice) {
    if (!matchup || submitting) return;
    setSubmitting(true);
    try {
      await submitVote(matchup.id, choice);
      const next = await fetchMatchup(matchup.prompt.id);
      setState({ kind: "ready", matchup: next });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Vote failed",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/40 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              Arena
            </div>
            <div className="text-xl font-semibold leading-tight">{title}</div>
            <div className="mt-1 text-sm text-muted">
              Vote for the better build. Curated prompts only.
            </div>
          </div>

          <PromptPicker
            selectedPromptId={selectedPromptId}
            onChangePromptId={(id) => setSelectedPromptId(id)}
          />
        </div>

        {state.kind === "error" ? (
          <div className="rounded-lg border border-border bg-bg/40 p-3 text-sm text-red-300">
            {state.message}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <VoxelViewerCard
            title="A"
            subtitle={matchup ? matchup.a.model.displayName : undefined}
            voxelBuild={matchup?.a.build ?? null}
            autoRotate
          />
          <VoxelViewerCard
            title="B"
            subtitle={matchup ? matchup.b.model.displayName : undefined}
            voxelBuild={matchup?.b.build ?? null}
            autoRotate
          />
        </div>

        <VoteBar
          disabled={state.kind !== "ready" || submitting}
          onVote={handleVote}
        />
      </div>
    </div>
  );
}

