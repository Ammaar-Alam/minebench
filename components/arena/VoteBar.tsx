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
  variant?: "default" | "ghost" | "danger";
}) {
  const base =
    "mb-btn h-10 disabled:cursor-not-allowed disabled:opacity-50";
  const cls = (() => {
    if (variant === "danger") return `${base} mb-btn-danger`;
    if (variant === "ghost") return `${base} mb-btn-ghost`;
    return `${base} mb-btn-primary`;
  })();
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
          variant="ghost"
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
