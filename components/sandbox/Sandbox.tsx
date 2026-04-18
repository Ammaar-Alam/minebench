"use client";

import { useState } from "react";
import { SandboxBenchmark } from "@/components/sandbox/SandboxBenchmark";
import { SandboxLive } from "@/components/sandbox/SandboxLive";

type SandboxMode = "benchmark" | "live";

function ModeSegmentedControl({
  value,
  onChange,
  className,
}: {
  value: SandboxMode;
  onChange: (value: SandboxMode) => void;
  className?: string;
}) {
  const options: Array<{ value: SandboxMode; label: string }> = [
    { value: "benchmark", label: "Model Comparison" },
    { value: "live", label: "Live Generate" },
  ];

  const safeCount = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const segmentWidth = `${100 / safeCount}%`;
  const segmentTranslate = `${activeIndex * 100}%`;

  return (
    <div
      className={`relative flex rounded-xl bg-bg/60 p-1 ring-1 ring-border ${className ?? ""}`}
    >
      <div className="pointer-events-none absolute inset-1 rounded-lg">
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-lg bg-accent/15 ring-1 ring-accent/40 transition-transform duration-200 ease-out"
          style={{
            width: segmentWidth,
            transform: `translateX(${segmentTranslate})`,
          }}
        />
      </div>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            className={`relative z-10 h-9 min-w-0 flex-1 rounded-lg px-3 text-xs font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-10 sm:px-4 sm:text-sm ${
              active ? "text-fg" : "text-muted hover:text-fg"
            }`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Sandbox({ initialPrompt }: { initialPrompt?: string }) {
  const [mode, setMode] = useState<SandboxMode>(() =>
    initialPrompt && initialPrompt.trim() ? "live" : "benchmark",
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <ModeSegmentedControl value={mode} onChange={setMode} className="w-full sm:w-[360px]" />
      </div>

      {mode === "benchmark" ? <SandboxBenchmark /> : <SandboxLive initialPrompt={initialPrompt} />}
    </div>
  );
}
