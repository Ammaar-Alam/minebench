"use client";

import { useFormStatus } from "react-dom";

export function LifecycleActionButton({
  label,
  pendingLabel,
  tone,
}: {
  label: string;
  pendingLabel: string;
  tone: "primary" | "ghost";
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={`mb-btn relative min-h-11 min-w-24 overflow-hidden px-5 ${
        tone === "primary" ? "mb-btn-primary" : "mb-btn-ghost"
      } disabled:cursor-wait disabled:opacity-80`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-3 h-1.5 w-1.5 rounded-full bg-current transition-[opacity,transform] duration-200 ease-out motion-reduce:animate-none motion-reduce:transition-none ${
          pending ? "scale-100 animate-pulse opacity-70" : "scale-50 opacity-0"
        }`}
      />
      <span aria-live="polite">{pending ? pendingLabel : label}</span>
    </button>
  );
}
