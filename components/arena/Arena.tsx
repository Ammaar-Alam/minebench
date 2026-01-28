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
    <div className="flex flex-col gap-4">
      <div className="mb-panel p-4">
        <div className="mb-panel-inner flex flex-col gap-3">
          {/* header + prompt inline */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="mb-badge shrink-0">
                <span className="mb-dot" />
                <span className="text-fg">Prompt</span>
              </div>
              {isLongPrompt ? (
                <button
                  type="button"
                  aria-expanded={promptExpanded}
                  className="mb-btn mb-btn-ghost h-8 shrink-0 px-3 text-[11px] sm:h-7 sm:px-2.5 sm:text-[10px]"
                  onClick={() => setPromptExpanded((v) => !v)}
                >
                  {promptExpanded ? "Less" : "More"}
                </button>
              ) : null}
            </div>

            <div className="min-w-0 flex-1">
              <div
                className={`${promptExpanded ? "max-h-32 overflow-auto" : "max-h-[3.9rem] overflow-hidden sm:max-h-[2.6rem]"} text-[14px] font-medium leading-snug text-fg transition-all duration-200`}
              >
                <AnimatedPrompt text={promptText || "Loading…"} isExpanded={promptExpanded} />
              </div>
            </div>
          </div>

          {state.kind === "error" ? (
            <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {state.message}
            </div>
          ) : null}

          {/* builds grid */}
          <div
            key={animKey}
            className="flex w-full snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:grid md:snap-none md:grid-cols-2 md:overflow-visible md:pb-0"
          >
            <div className="mb-card-enter min-w-[88%] shrink-0 snap-center md:min-w-0 md:shrink md:snap-none">
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
            <div className="mb-card-enter mb-card-enter-delay min-w-[88%] shrink-0 snap-center md:min-w-0 md:shrink md:snap-none">
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

          <div className="flex items-center justify-between text-xs text-muted md:hidden">
            <span>Swipe to compare</span>
            <span className="font-mono">A ⇄ B</span>
          </div>

          {/* vote bar - no wrapper panel */}
          <VoteBar
            disabled={state.kind !== "ready" || submitting}
            onVote={handleVote}
            onSkip={handleSkip}
          />
        </div>
      </div>

      {/* explanatory section */}
      <div className="mb-panel mb-panel-solid overflow-hidden p-8 md:p-10">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent ring-1 ring-accent/20">
            <span>Unofficial Benchmark</span>
          </div>
          <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-fg md:text-3xl">
            Spatial Intelligence Test
          </h2>
          <p className="mb-12 max-w-2xl text-base leading-relaxed text-fg/85">
            MineBench evaluates how well AI models understand 3D space. Models must generate raw
            JSON coordinates for Minecraft blocks—no images, no 3D tools. We visualize their pure
            code output here.
          </p>

          <div className="grid w-full grid-cols-1 gap-4 text-left sm:gap-5 md:grid-cols-2 lg:grid-cols-3 lg:gap-6">
            <div className="flex h-full flex-col rounded-2xl border border-border/40 bg-bg/30 p-6">
              <div className="mb-4 text-accent">
                <svg
                  className="h-6 w-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <path d="M3.3 7l8.7 5 8.7-5" />
                  <path d="M12 22v-9" />
                </svg>
              </div>
              <div className="mb-2 font-semibold text-fg">Pure Logic</div>
              <div className="text-sm leading-relaxed text-fg/75">
                Models blindly derive 3D coordinates using only math and spatial reasoning. They ARE
                allowed to execute code (python) to help create the JSON; specifically they are
                given a custom voxelBuilder tool which gives them access to primitive functions such
                as cube, sphere, and square.
              </div>
            </div>

            <div className="flex h-full flex-col rounded-2xl border border-border/40 bg-bg/30 p-6">
              <div className="mb-4 text-accent">
                <svg
                  className="h-6 w-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 3v18h18" />
                  <path d="M18 17V9" />
                  <path d="M13 17V5" />
                  <path d="M8 17v-3" />
                </svg>
              </div>
              <div className="mb-2 font-semibold text-fg">Elo Rated</div>
              <div className="text-sm leading-relaxed text-fg/75">
                Builds are ranked via head-to-head voting, creating a live leaderboard of spatial
                skill.
              </div>
            </div>

            <div className="flex h-full flex-col rounded-2xl border border-border/40 bg-bg/30 p-6">
              <div className="mb-4 text-accent">
                <svg
                  className="h-6 w-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s 9-1.34 9-3V5" />
                </svg>
              </div>
              <div className="mb-2 font-semibold text-fg">Recorded Data</div>
              <div className="text-sm leading-relaxed text-fg/75">
                Prompts, generations, and votes are stored to compute rankings and track
                performance.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* sandbox cta - moved to bottom & polished */}
      <div className="mb-panel mb-panel-solid flex flex-col items-center gap-4 p-6 text-center md:p-7">
        <div className="flex flex-col items-center gap-1">
          <h3 className="font-semibold text-fg">Want to test a model yourself?</h3>
          <p className="text-sm text-fg/70">
            Enter any prompt to generate a 3D build in the Sandbox.
          </p>
        </div>
        <div className="relative flex w-full max-w-md items-center">
          <input
            className="mb-field h-12 w-full pr-24 text-base shadow-sm focus:ring-accent/20"
            placeholder="e.g. A giant rubber duck..."
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
          />
          <div className="absolute right-1.5 top-1.5 bottom-1.5">
            <a
              className="mb-btn mb-btn-primary h-full px-4 text-sm shadow-sm"
              href={`/sandbox${customPrompt.trim() ? `?prompt=${encodeURIComponent(customPrompt.trim())}` : ""}`}
            >
              Generate
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
