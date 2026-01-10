"use client";

import { useEffect, useState } from "react";
import { ArenaMatchup, VoteChoice } from "@/lib/arena/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { VoteBar } from "@/components/arena/VoteBar";
import { AnimatedPrompt } from "@/components/arena/AnimatedPrompt";
import { ModelReveal } from "@/components/arena/ModelReveal";

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
  const [animKey, setAnimKey] = useState(0);

  const matchup = state.kind === "ready" ? state.matchup : null;
  const revealModels = Boolean(matchup && revealMatchupId === matchup.id);

  useEffect(() => {
    setPromptExpanded(false);
  }, [matchup?.id]);

  useEffect(() => {
    if (!matchup?.id) return;
    setAnimKey((k) => k + 1);
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
      const minRevealMs = 900;
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
    }
  }

  async function handleSkip() {
    if (!matchup || submitting) return;
    setSubmitting(true);
    try {
      const revealAt = Date.now();
      setRevealMatchupId(matchup.id);
      const next = await fetchMatchup(undefined);
      const minRevealMs = 800;
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

  const promptText = matchup?.prompt.text ?? "";
  const isLongPrompt = promptText.length > 120;

  return (
    <div className="flex flex-col gap-6">
      <div className="mb-panel p-5">
        <div className="mb-panel-inner flex flex-col gap-5">
          {/* header row */}
          <div className="flex items-start justify-between gap-4">
            <div className="mb-badge w-fit">
              <span className="mb-dot" />
              <span className="text-fg">Arena</span>
            </div>
            {isLongPrompt && (
              <button
                type="button"
                aria-expanded={promptExpanded}
                className="mb-btn mb-btn-ghost h-8 px-3 text-[11px]"
                onClick={() => setPromptExpanded((v) => !v)}
              >
                {promptExpanded ? "Collapse" : "Expand"}
              </button>
            )}
          </div>

          {/* prompt area - compact */}
          <div className="mb-subpanel px-4 py-3">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted/70">
              Prompt
            </div>
            <div
              className={`${promptExpanded ? "max-h-48 overflow-auto" : "max-h-16 overflow-hidden"} transition-all duration-200`}
            >
              <div
                className={`${promptExpanded ? "" : "mb-clamp-3"} text-[15px] font-medium leading-relaxed text-fg`}
              >
                <AnimatedPrompt
                  text={promptText || "Loading…"}
                  isExpanded={promptExpanded}
                />
              </div>
            </div>
          </div>

          {state.kind === "error" ? (
            <div className="mb-subpanel p-3 text-sm text-danger">
              {state.message}
            </div>
          ) : null}

          {/* builds grid */}
          <div key={animKey} className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="mb-card-enter">
              <VoxelViewerCard
                title="Build A"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.a.model.provider}
                    modelName={matchup?.a.model.displayName}
                  />
                }
                voxelBuild={matchup?.a.build ?? null}
                autoRotate
              />
            </div>
            <div className="mb-card-enter mb-card-enter-delay">
              <VoxelViewerCard
                title="Build B"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.b.model.provider}
                    modelName={matchup?.b.model.displayName}
                  />
                }
                voxelBuild={matchup?.b.build ?? null}
                autoRotate
              />
            </div>
          </div>

          {/* vote bar */}
          <div className="mb-subpanel p-4">
            <VoteBar
              disabled={state.kind !== "ready" || submitting}
              onVote={handleVote}
              onSkip={handleSkip}
            />
          </div>

          {/* sandbox cta */}
          <div className="mb-subpanel flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-muted">Want full control?</div>
            <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center">
              <input
                className="mb-field h-10 md:w-72"
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
