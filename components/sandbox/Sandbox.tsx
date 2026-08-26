"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SandboxBenchmark } from "@/components/sandbox/SandboxBenchmark";
import { SandboxLive } from "@/components/sandbox/SandboxLive";
import {
  buildSandboxModePath,
  readSandboxUrlMode,
  type SandboxUrlMode,
} from "@/lib/deepLinks";

const LocalLab = dynamic(
  () => import("@/components/local/LocalLab").then((module) => module.LocalLab),
  { loading: () => <div aria-hidden="true" className="min-h-[24rem]" /> },
);

function SandboxModeTabs({
  value,
  onChange,
  hrefFor,
  className,
}: {
  value: SandboxUrlMode;
  onChange: (value: SandboxUrlMode) => void;
  hrefFor: (value: SandboxUrlMode) => string;
  className?: string;
}) {
  const options: Array<{ value: SandboxUrlMode; label: string }> = [
    { value: "benchmark", label: "Compare" },
    { value: "live", label: "Generate" },
    { value: "import", label: "Import" },
  ];

  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <nav
      aria-label="Sandbox modes"
      className={`relative grid grid-cols-3 border-b border-border/70 ${className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-px left-0 h-0.5 w-1/3 bg-accent transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <a
            key={option.value}
            aria-current={active ? "page" : undefined}
            className={`grid min-h-11 min-w-0 place-items-center px-3 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 motion-reduce:transition-none ${
              active ? "text-fg" : "text-muted hover:text-fg"
            }`}
            href={hrefFor(option.value)}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              onChange(option.value);
            }}
          >
            {option.label}
          </a>
        );
      })}
    </nav>
  );
}

export function Sandbox({ initialPrompt, signedIn }: { initialPrompt?: string; signedIn: boolean }) {
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const livePrompt =
    searchParams.get("prompt") ?? (searchKey ? undefined : initialPrompt);
  const [mode, setMode] = useState<SandboxUrlMode>(() =>
    readSandboxUrlMode(new URLSearchParams(searchKey)),
  );

  useEffect(() => {
    setMode(readSandboxUrlMode(new URLSearchParams(searchKey)));
  }, [searchKey]);

  function handleModeChange(nextMode: SandboxUrlMode) {
    setMode(nextMode);
    const nextPath = buildSandboxModePath(
      new URLSearchParams(window.location.search),
      nextMode,
    );
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (nextPath !== currentPath) {
      window.history.pushState(null, "", nextPath);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="mb-eyebrow">Sandbox</span>
        <SandboxModeTabs
          value={mode}
          onChange={handleModeChange}
          hrefFor={(nextMode) =>
            buildSandboxModePath(new URLSearchParams(searchKey), nextMode)
          }
          className="w-full sm:w-[336px]"
        />
      </div>

      {mode === "benchmark" ? (
        <SandboxBenchmark />
      ) : mode === "live" ? (
        <SandboxLive key={livePrompt ?? "default"} initialPrompt={livePrompt} signedIn={signedIn} />
      ) : (
        <LocalLab />
      )}
    </div>
  );
}
