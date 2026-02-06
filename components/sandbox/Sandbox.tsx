"use client";

import { useState } from "react";
import { SandboxBenchmark } from "@/components/sandbox/SandboxBenchmark";
import { SandboxLive } from "@/components/sandbox/SandboxLive";

type SandboxMode = "benchmark" | "live";

export function Sandbox({ initialPrompt }: { initialPrompt?: string }) {
  const [mode, setMode] = useState<SandboxMode>(() =>
    initialPrompt && initialPrompt.trim() ? "live" : "benchmark"
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

          <div className="grid w-full grid-cols-2 gap-1 rounded-xl bg-bg/55 p-1 ring-1 ring-border/80 sm:w-auto">
            <button
              type="button"
              className={`mb-btn h-9 px-3 text-xs sm:px-4 sm:text-sm ${
                mode === "benchmark" ? "mb-btn-primary" : "mb-btn-ghost"
              }`}
              onClick={() => setMode("benchmark")}
            >
              Benchmark Compare
            </button>
            <button
              type="button"
              className={`mb-btn h-9 px-3 text-xs sm:px-4 sm:text-sm ${
                mode === "live" ? "mb-btn-primary" : "mb-btn-ghost"
              }`}
              onClick={() => setMode("live")}
            >
              Live Generate
            </button>
          </div>
        </div>
      </div>

      {mode === "benchmark" ? <SandboxBenchmark /> : <SandboxLive initialPrompt={initialPrompt} />}
    </div>
  );
}
