"use client";

import { VoteChoice } from "@/lib/arena/types";

function VoteButton({
  label,
  onClick,
  disabled,
  variant = "default",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger";
}) {
  const base =
    "h-10 rounded-md px-3 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed";
  const cls =
    variant === "danger"
      ? `${base} bg-red-500/15 text-red-200 ring-1 ring-red-400/30 hover:bg-red-500/20`
      : `${base} bg-accent/15 text-fg ring-1 ring-accent/30 hover:bg-accent/20`;
  return (
    <button className={cls} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

export function VoteBar({
  disabled,
  onVote,
}: {
  disabled?: boolean;
  onVote: (choice: VoteChoice) => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <div className="text-sm text-muted">Which build is better?</div>
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap">
        <VoteButton disabled={disabled} label="Vote A" onClick={() => onVote("A")} />
        <VoteButton disabled={disabled} label="Vote B" onClick={() => onVote("B")} />
        <VoteButton
          disabled={disabled}
          label="Tie"
          onClick={() => onVote("TIE")}
        />
        <VoteButton
          disabled={disabled}
          label="Both bad"
          variant="danger"
          onClick={() => onVote("BOTH_BAD")}
        />
      </div>
    </div>
  );
}

