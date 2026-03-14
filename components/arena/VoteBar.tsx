"use client";

import { VoteChoice } from "@/lib/arena/types";

function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 4L6 8L10 12" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4L10 8L6 12" />
    </svg>
  );
}

function Equal({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 6h10M3 10h10" />
    </svg>
  );
}

function X({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function SkipForward({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 3l6 5-6 5V3z" />
      <path d="M12 4v8" />
    </svg>
  );
}

export function VoteBar({
  disabled,
  disableVotes,
  onVote,
  onSkip,
}: {
  disabled?: boolean;
  disableVotes?: boolean;
  onVote: (choice: VoteChoice) => void;
  onSkip: () => void;
}) {
  const voteDisabled = Boolean(disabled || disableVotes);
  const buttonBase =
    "inline-flex touch-manipulation select-none items-center justify-center gap-1.5 rounded-xl font-semibold transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40";
  const mobilePrimary =
    "h-11 px-3 text-[13px]";
  const mobileSecondary = "h-9 px-2.5 text-[12px]";
  const desktopBase = "h-11 px-4 text-sm sm:rounded-xl";

  return (
    <div className="mb-subpanel relative h-full overflow-hidden px-2 py-2 sm:px-3.5 sm:py-3">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/[0.06] via-transparent to-accent2/[0.06]"
      />

      <div className="relative flex h-full flex-col justify-center gap-1.5">
        <div className="grid grid-cols-2 gap-1.5 sm:hidden">
          <button
            aria-label="Vote for Build A"
            className={`${buttonBase} ${mobilePrimary} mb-vote-a`}
            disabled={voteDisabled}
            onClick={() => onVote("A")}
          >
            <ChevronLeft className="h-4 w-4 opacity-70" />
            <span>A wins</span>
          </button>

          <button
            aria-label="Vote for Build B"
            className={`${buttonBase} ${mobilePrimary} mb-vote-b`}
            disabled={voteDisabled}
            onClick={() => onVote("B")}
          >
            <span>B wins</span>
            <ChevronRight className="h-4 w-4 opacity-70" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1.5 sm:hidden">
          <button
            aria-label="Tie"
            className={`${buttonBase} ${mobileSecondary} mb-vote-tie`}
            disabled={voteDisabled}
            onClick={() => onVote("TIE")}
          >
            <Equal className="h-3.5 w-3.5 opacity-70" />
            <span>Tie</span>
          </button>

          <button
            aria-label="Both bad"
            className={`${buttonBase} ${mobileSecondary} mb-vote-bad`}
            disabled={voteDisabled}
            onClick={() => onVote("BOTH_BAD")}
          >
            <X className="h-3.5 w-3.5 opacity-70" />
            <span>Bad</span>
          </button>

          <button
            aria-label="Skip"
            className={`${buttonBase} ${mobileSecondary} mb-vote-skip`}
            disabled={disabled}
            onClick={onSkip}
          >
            <SkipForward className="h-3.5 w-3.5 opacity-70" />
            <span>Skip</span>
          </button>
        </div>

        <div className="hidden flex-col justify-center gap-1.5 sm:flex sm:gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-2.5">
            <button
              aria-label="Vote for Build A"
              className={`${buttonBase} ${desktopBase} mb-vote-a flex-1`}
              disabled={voteDisabled}
              onClick={() => onVote("A")}
            >
              <ChevronLeft className="h-4 w-4 opacity-70" />
              <span>A wins</span>
              <span className="hidden md:inline-flex"><span className="mb-kbd">1</span></span>
            </button>

            <button
              aria-label="Tie"
              className={`${buttonBase} ${desktopBase} mb-vote-tie`}
              disabled={voteDisabled}
              onClick={() => onVote("TIE")}
            >
              <Equal className="h-3.5 w-3.5 opacity-70" />
              <span>Tie</span>
            </button>

            <button
              aria-label="Vote for Build B"
              className={`${buttonBase} ${desktopBase} mb-vote-b flex-1`}
              disabled={voteDisabled}
              onClick={() => onVote("B")}
            >
              <span>B wins</span>
              <span className="hidden md:inline-flex"><span className="mb-kbd">2</span></span>
              <ChevronRight className="h-4 w-4 opacity-70" />
            </button>
          </div>

          <div className="flex items-center justify-center gap-2 sm:gap-2.5">
            <button
              aria-label="Both bad"
              className={`${buttonBase} ${desktopBase} mb-vote-bad h-9 min-w-[9.5rem] flex-none`}
              disabled={voteDisabled}
              onClick={() => onVote("BOTH_BAD")}
            >
              <X className="h-3.5 w-3.5 opacity-70" />
              <span>Both bad</span>
              <span className="hidden md:inline-flex"><span className="mb-kbd">↓</span></span>
            </button>

            <button
              aria-label="Skip"
              className={`${buttonBase} ${desktopBase} mb-vote-skip h-9 min-w-[9.5rem] flex-none`}
              disabled={disabled}
              onClick={onSkip}
            >
              <SkipForward className="h-3.5 w-3.5 opacity-70" />
              <span>Skip</span>
              <span className="hidden md:inline-flex"><span className="mb-kbd">Space</span></span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
