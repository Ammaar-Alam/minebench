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
    { value: "benchmark", label: "Benchmark Compare" },
    { value: "live", label: "Live Generate" },
  ];

  const safeCount = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const segmentWidth = `calc((100% - 0.5rem) / ${safeCount})`;
  const segmentTranslate = `${activeIndex * 100}%`;

  return (
    <div
      className={`relative flex rounded-full bg-bg/55 p-1 ring-1 ring-border/80 ${className ?? ""}`}
    >
      <div className="pointer-events-none absolute inset-1 rounded-full">
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-full border border-accent/55 bg-accent/24 shadow-[0_8px_20px_-14px_rgba(61,229,204,0.85)] transition-transform duration-300 ease-out"
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
            className={`relative z-10 h-9 flex-1 rounded-full px-3 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
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
    <div className="flex flex-col gap-5">
      <div className="mb-panel p-3 sm:p-4">
        <div className="mb-panel-inner flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <div className="mb-badge">
              <span className="mb-dot" />
              <span className="text-fg">Sandbox Mode</span>
            </div>
            <div className="hidden text-xs text-muted sm:block">
              Benchmark compare uses seeded Arena builds. Live generate uses your own keys.
            </div>
          </div>

          <ModeSegmentedControl value={mode} onChange={setMode} className="w-full sm:w-[420px]" />
        </div>
      </div>

      {mode === "benchmark" ? <SandboxBenchmark /> : <SandboxLive initialPrompt={initialPrompt} />}
    </div>
  );
}
