"use client";

import { VoteChoice } from "@/lib/arena/types";

function VoteButton({
  label,
  onClick,
  disabled,
  variant = "default",
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "ghost" | "danger";
  className?: string;
}) {
  const base =
    "mb-btn h-12 rounded-2xl disabled:cursor-not-allowed disabled:opacity-50 hover:-translate-y-0.5";
  const cls = (() => {
    if (variant === "danger") return `${base} mb-btn-danger`;
    if (variant === "ghost") return `${base} mb-btn-ghost`;
    return `${base} mb-btn-primary`;
  })();
  return (
    <button className={`${cls} ${className ?? ""}`} disabled={disabled} onClick={onClick}>
      {label}
    </button>
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-fg">Which build is better?</div>
        <button
          className="mb-btn mb-btn-ghost h-9 px-3 text-xs"
          disabled={disabled}
          onClick={onSkip}
        >
          Skip
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <VoteButton disabled={disabled} label="A is better" onClick={() => onVote("A")} />
        <VoteButton disabled={disabled} label="B is better" onClick={() => onVote("B")} />
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
