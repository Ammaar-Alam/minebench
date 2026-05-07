"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { VoxelBuildExportFormat, VoxelBuildExportStats } from "@/lib/voxel/export";
import type { VoxelBuild } from "@/lib/voxel/types";

type Props = {
  build: VoxelBuild | null;
  palette: "simple" | "advanced";
  fileLabel?: string;
  promptText?: string;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
};

type WorkerResponse =
  | { type: "progress"; requestId: string; stage: string }
  | {
      type: "complete";
      requestId: string;
      extension: "glb" | "stl" | "schem";
      mimeType: string;
      stats: VoxelBuildExportStats;
      bytes: ArrayBuffer;
    }
  | { type: "error"; requestId: string; message: string };

type ExportStatus =
  | { type: "idle" }
  | { type: "working"; requestId: string; format: VoxelBuildExportFormat; stage: string }
  | { type: "done"; format: VoxelBuildExportFormat; stats: VoxelBuildExportStats }
  | { type: "error"; message: string };

const EXPORT_OPTIONS: Array<{
  format: VoxelBuildExportFormat;
  label: string;
  detail: string;
}> = [
  { format: "glb", label: "Blender", detail: "GLB" },
  { format: "stl", label: "STL", detail: "Mesh" },
  { format: "schem", label: "Minecraft", detail: "WorldEdit" },
];

function sanitizeFilePart(value: string | undefined): string {
  const clean = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.slice(0, 48);
}

function buildFileName(extension: string, fileLabel?: string, promptText?: string) {
  const parts = [
    "minebench",
    sanitizeFilePart(fileLabel),
    sanitizeFilePart(promptText),
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
  ].filter(Boolean);
  return `${parts.join("-")}.${extension}`;
}

function downloadBuffer(buffer: ArrayBuffer, mimeType: string, fileName: string) {
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function formatStats(stats: VoxelBuildExportStats) {
  if (typeof stats.triangleCount === "number") {
    return `${stats.triangleCount.toLocaleString()} triangles`;
  }
  if (typeof stats.volume === "number") {
    return `${stats.exportedBlockCount.toLocaleString()} blocks`;
  }
  return `${stats.exportedBlockCount.toLocaleString()} blocks`;
}

export function VoxelBuildExportButton({
  build,
  palette,
  fileLabel,
  promptText,
  disabled,
  disabledReason,
  className,
}: Props) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<ExportStatus>({ type: "idle" });
  const isWorking = status.type === "working";
  const isDisabled = disabled || !build || isWorking;

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const startExport = (format: VoxelBuildExportFormat) => {
    if (!build || isWorking) return;

    workerRef.current?.terminate();
    const worker = new Worker(new URL("./voxelBuildExport.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const requestId = `${format}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setStatus({ type: "working", requestId, format, stage: "Preparing" });
    setMenuOpen(false);

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;

      if (message.type === "progress") {
        setStatus({ type: "working", requestId, format, stage: message.stage });
        return;
      }

      worker.terminate();
      workerRef.current = null;

      if (message.type === "error") {
        setStatus({ type: "error", message: message.message || "Export failed" });
        return;
      }

      const fileName = buildFileName(message.extension, fileLabel, promptText);
      downloadBuffer(message.bytes, message.mimeType, fileName);
      setStatus({ type: "done", format, stats: message.stats });
    };

    worker.onerror = (event) => {
      worker.terminate();
      workerRef.current = null;
      setStatus({ type: "error", message: event.message || "Export failed" });
    };

    worker.postMessage({ type: "export", requestId, format, build, palette });
  };

  const statusText =
    status.type === "working"
      ? status.stage
      : status.type === "done"
        ? formatStats(status.stats)
        : status.type === "error"
          ? status.message
          : null;

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        aria-label="Export build"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        disabled={isDisabled}
        onClick={() => setMenuOpen((open) => !open)}
        className="mb-btn mb-btn-ghost h-8 w-8 rounded-full border border-border/70 bg-bg/55 p-0 text-muted shadow-sm backdrop-blur-sm hover:border-accent/60 hover:bg-accent/10 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
        title={disabledReason ?? "Export build"}
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m12 3 7 4-7 4-7-4 7-4z" />
          <path d="M5 7v8l7 4 7-4V7" />
          <path d="M12 11v8" />
          <path d="M12 5.5v6" />
          <path d="m9.8 9.7 2.2 2.2 2.2-2.2" />
        </svg>
      </button>

      {menuOpen ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-10 z-40 w-44 overflow-hidden rounded-lg border border-border/80 bg-bg/95 p-1.5 shadow-xl shadow-black/20 backdrop-blur-md"
        >
          {EXPORT_OPTIONS.map((option) => (
            <button
              key={option.format}
              type="button"
              role="menuitem"
              onClick={() => startExport(option.format)}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-fg transition hover:bg-accent/12 hover:text-fg"
            >
              <span className="font-medium">{option.label}</span>
              <span className="font-mono text-[10px] uppercase tracking-normal text-muted">
                {option.detail}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {statusText ? (
        <div
          className={`absolute right-0 top-10 z-30 max-w-[220px] rounded-md border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg backdrop-blur-md ${
            status.type === "error"
              ? "border-danger/40 bg-danger/12 text-danger"
              : "border-border/70 bg-bg/85 text-muted"
          }`}
        >
          {statusText}
        </div>
      ) : null}
    </div>
  );
}
