"use client";

import { useEffect, useState } from "react";
import { ArenaMatchup, VoteChoice } from "@/lib/arena/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
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
  const [submitting, setSubmitting] = useState(false);
  const [revealMatchupId, setRevealMatchupId] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [promptExpanded, setPromptExpanded] = useState(false);

  const matchup = state.kind === "ready" ? state.matchup : null;
  const revealModels = Boolean(matchup && revealMatchupId === matchup.id);

  useEffect(() => {
    setPromptExpanded(false);
  }, [matchup?.id]);

  function sleepMs(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchMatchup(undefined)
      .then((m) => {
        if (cancelled) return;
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
  }, []);

  async function handleVote(choice: VoteChoice) {
    if (!matchup || submitting) return;
    setSubmitting(true);
    setRevealMatchupId(matchup.id);
    try {
      const revealAt = Date.now();
      await submitVote(matchup.id, choice);
      const next = await fetchMatchup(undefined);
      const minRevealMs = 550;
      const remaining = minRevealMs - (Date.now() - revealAt);
      if (remaining > 0) await sleepMs(remaining);
      setState({ kind: "ready", matchup: next });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Vote failed",
      });
    } finally {
      setSubmitting(false);
      // Note: we intentionally keep revealMatchupId set to the voted matchup id.
      // The next matchup has a different id, so model names remain hidden again.
    }
  }

  async function handleSkip() {
    if (!matchup || submitting) return;
    setSubmitting(true);
    try {
      const revealAt = Date.now();
      setRevealMatchupId(matchup.id);
      const next = await fetchMatchup(undefined);
      const minRevealMs = 650;
      const remaining = minRevealMs - (Date.now() - revealAt);
      if (remaining > 0) await sleepMs(remaining);
      setState({ kind: "ready", matchup: next });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load matchup",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="mb-panel p-5">
        <div className="mb-panel-inner flex flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="flex flex-col gap-2">
              <div className="mb-badge w-fit">
                <span className="mb-dot" />
                <span className="text-fg">Arena</span>
              </div>

              <div className="mb-subpanel w-full px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-medium text-muted">Prompt</div>
                  {(() => {
                    const canExpand = Boolean(matchup?.prompt.text && matchup.prompt.text.length > 160);
                    return (
                      <button
                        type="button"
                        aria-expanded={promptExpanded}
                        className={`mb-btn mb-btn-ghost h-8 px-3 text-[11px] ${canExpand ? "" : "invisible"}`}
                        onClick={() => setPromptExpanded((v) => !v)}
                        disabled={!canExpand}
                      >
                        {promptExpanded ? "Collapse" : "Expand"}
                      </button>
                    );
                  })()}
                </div>
                <div className="mt-1 h-28 overflow-hidden md:h-32">
                  <div
                    className={`h-full pr-1 ${promptExpanded ? "overflow-auto" : "overflow-hidden"}`}
                    aria-label="Prompt text"
                  >
                    <div
                      className={`${promptExpanded ? "" : "mb-clamp-prompt"} font-display text-lg font-semibold leading-snug tracking-tight text-fg md:text-xl`}
                      title={matchup?.prompt.text ?? ""}
                    >
                      {matchup?.prompt.text ?? "Loading…"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="text-sm text-muted">
            Vote for the better build.
          </div>

          {state.kind === "error" ? (
            <div className="mb-subpanel p-3 text-sm text-danger">
              {state.message}
            </div>
          ) : null}

          {state.kind === "error" ? (
            <div className="mb-subpanel p-3 text-sm text-muted">
              If this is a fresh install, seed curated prompts/builds via{" "}
              <span className="font-mono">/api/admin/seed</span> (see README).
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <VoxelViewerCard
              title={revealModels ? matchup?.a.model.displayName ?? "Build A" : "Build A"}
              subtitle={
                revealModels
                  ? `${matchup?.a.model.provider ?? ""}`
                  : "Model hidden"
              }
              voxelBuild={matchup?.a.build ?? null}
              autoRotate
            />
            <VoxelViewerCard
              title={revealModels ? matchup?.b.model.displayName ?? "Build B" : "Build B"}
              subtitle={
                revealModels
                  ? `${matchup?.b.model.provider ?? ""}`
                  : "Model hidden"
              }
              voxelBuild={matchup?.b.build ?? null}
              autoRotate
            />
          </div>

          <div className="mb-subpanel p-4">
            <VoteBar
              disabled={state.kind !== "ready" || submitting}
              onVote={handleVote}
              onSkip={handleSkip}
            />
          </div>

          <div className="mb-subpanel flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-col gap-1">
              <div className="text-sm text-fg">Want full control?</div>
            </div>
            <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center">
              <input
                className="mb-field h-10 md:w-80"
                placeholder="your own prompt…"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
              />
              <a
                className="mb-btn mb-btn-primary h-10"
                href={`/sandbox${customPrompt.trim() ? `?prompt=${encodeURIComponent(customPrompt.trim())}` : ""}`}
              >
                Open Sandbox
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
