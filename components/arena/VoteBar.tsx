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
  onVote,
  onSkip,
}: {
  disabled?: boolean;
  onVote: (choice: VoteChoice) => void;
  onSkip: () => void;
}) {
  const base =
    "inline-flex select-none items-center justify-center gap-1.5 rounded-xl text-sm font-semibold transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-col gap-2">
      {/* main row: A | Tie | B */}
      <div className="flex items-center gap-2">
        <button
          className={`${base} mb-vote-a h-11 flex-1 px-4`}
          disabled={disabled}
          onClick={() => onVote("A")}
        >
          <ChevronLeft className="h-4 w-4 opacity-70" />
          <span>A is better</span>
        </button>

        <button
          className={`${base} mb-vote-tie h-11 px-5`}
          disabled={disabled}
          onClick={() => onVote("TIE")}
        >
          <Equal className="h-3.5 w-3.5 opacity-70" />
          <span>Tie</span>
        </button>

        <button
          className={`${base} mb-vote-b h-11 flex-1 px-4`}
          disabled={disabled}
          onClick={() => onVote("B")}
        >
          <span>B is better</span>
          <ChevronRight className="h-4 w-4 opacity-70" />
        </button>
      </div>

      {/* secondary row: Both bad | Skip */}
      <div className="flex items-center justify-center gap-2">
        <button
          className={`${base} mb-vote-bad h-9 px-4`}
          disabled={disabled}
          onClick={() => onVote("BOTH_BAD")}
        >
          <X className="h-3.5 w-3.5 opacity-70" />
          <span>Both bad</span>
        </button>

        <button
          className={`${base} mb-vote-skip h-9 px-4`}
          disabled={disabled}
          onClick={onSkip}
        >
          <SkipForward className="h-3.5 w-3.5 opacity-70" />
          <span>Skip</span>
        </button>
      </div>
    </div>
  );
}
