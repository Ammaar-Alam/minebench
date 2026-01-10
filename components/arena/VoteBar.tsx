"use client";

import { VoteChoice } from "@/lib/arena/types";

export function VoteBar({
  disabled,
  onVote,
  onSkip,
}: {
  disabled?: boolean;
  onVote: (choice: VoteChoice) => void;
  onSkip: () => void;
}) {
  const baseBtn =
    "inline-flex select-none items-center justify-center rounded-xl px-4 text-sm font-semibold text-fg transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col gap-4">
      {/* hero buttons row */}
      <div className="grid grid-cols-2 gap-3">
        <button
          className={`${baseBtn} mb-vote-a h-14 text-base`}
          disabled={disabled}
          onClick={() => onVote("A")}
        >
          A is better
        </button>
        <button
          className={`${baseBtn} mb-vote-b h-14 text-base`}
          disabled={disabled}
          onClick={() => onVote("B")}
        >
          B is better
        </button>
      </div>

      {/* secondary row */}
      <div className="flex items-center gap-2">
        <button
          className={`${baseBtn} mb-vote-secondary h-10 flex-1`}
          disabled={disabled}
          onClick={() => onVote("TIE")}
        >
          Tie
        </button>
        <button
          className={`${baseBtn} mb-vote-bad h-10 flex-1`}
          disabled={disabled}
          onClick={() => onVote("BOTH_BAD")}
        >
          Both bad
        </button>
        <button
          className={`${baseBtn} mb-vote-secondary h-10 px-5`}
          disabled={disabled}
          onClick={onSkip}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
