"use client";

import type { RefObject } from "react";
import { useState } from "react";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";

export type SandboxGifExportTarget = {
  viewerRef: RefObject<VoxelViewerHandle | null>;
  modelName: string;
  company: string;
  blockCount: number;
};

type Props = {
  targets: SandboxGifExportTarget[];
  promptText?: string;
  label?: string;
  iconOnly?: boolean;
  className?: string;
};

// GIFs are a compromise: higher FPS + small rotation steps look smoother, but cost encode time + file size.
// These defaults target "pretty smooth" while keeping render time reasonable.
const FRAME_DELAY_MS = 10; // 25fps (GIF delay is in 1/100s units under the hood)
const FRAME_COUNT = 128; // ~5.6s total, last frame matches first for a seamless loop
const MAX_IN_FLIGHT_FRAMES = 6; // pipeline main-thread capture with worker encoding
const YIELD_EVERY_FRAMES = 50; // keep UI responsive without adding ~16ms per frame
const CAPTURE_SUPERSAMPLE = 1.35;
const EXPORT_SIZE_SINGLE = { width: 1080, height: 640 };
const EXPORT_SIZE_COMPARE = { width: 1728, height: 972 };

const EXPORT_MARGIN_X = 22;
const EXPORT_MARGIN_BOTTOM = 22;
const PANEL_GAP = 16;
const PANEL_PAD = 12;
const PANEL_META_HEIGHT = 62;
const PANEL_RADIUS = 18;
const CAPTURE_RADIUS = 14;

function sanitizeFilePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function fitTextWithEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (ctx.measureText(clean).width <= maxWidth) return clean;
  const ellipsis = "...";
  let lo = 0;
  let hi = clean.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${clean.slice(0, mid).replace(/\s+$/g, "")}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${clean.slice(0, lo).replace(/\s+$/g, "")}${ellipsis}`;
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const lines: string[] = [];

  let current = "";
  let idx = 0;
  while (idx < words.length) {
    const next = current ? `${current} ${words[idx]}` : words[idx];
    if (ctx.measureText(next).width <= maxWidth || current === "") {
      current = next;
      idx += 1;
      continue;
    }

    lines.push(current);
    current = "";
    if (lines.length >= Math.max(1, maxLines - 1)) break;
  }

  if (current && lines.length < maxLines) lines.push(current);

  if (idx < words.length && lines.length > 0) {
    const remainder = words.slice(idx).join(" ");
    const last = lines.pop() ?? "";
    const combined = last ? `${last} ${remainder}` : remainder;
    lines.push(fitTextWithEllipsis(ctx, combined, maxWidth));
  }

  return lines.slice(0, maxLines);
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawBaseBackdrop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: {
    title: string;
    promptLines: string[];
    urlText: string;
  },
) {
  // Keep the background smooth and low-detail so the 256-color GIF palette is spent on the builds (less "static").
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, width, height);

  const wash = ctx.createLinearGradient(0, 0, width, height);
  wash.addColorStop(0, "rgba(56, 189, 248, 0.05)");
  wash.addColorStop(0.6, "rgba(15, 23, 42, 0)");
  wash.addColorStop(1, "rgba(148, 163, 184, 0.035)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  const vignette = ctx.createRadialGradient(
    width * 0.55,
    height * 0.35,
    Math.max(40, Math.min(width, height) * 0.12),
    width * 0.55,
    height * 0.35,
    Math.max(width, height) * 0.85,
  );
  vignette.addColorStop(0, "rgba(255, 255, 255, 0.05)");
  vignette.addColorStop(0.55, "rgba(255, 255, 255, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.35)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(203, 213, 225, 0.98)";
  ctx.font = '700 28px "Sora", "Avenir Next", "Segoe UI", sans-serif';
  ctx.textBaseline = "top";
  ctx.fillText(opts.title, 28, 18);

  ctx.fillStyle = "rgba(148, 163, 184, 0.95)";
  ctx.font = '500 13px "IBM Plex Sans", "Segoe UI", sans-serif';
  const promptY = 54;
  const lineHeight = 16;
  for (let i = 0; i < opts.promptLines.length; i += 1) {
    ctx.fillText(opts.promptLines[i] ?? "", 28, promptY + i * lineHeight);
  }

  ctx.fillStyle = "rgba(100, 116, 139, 0.85)";
  ctx.font = '500 11px "IBM Plex Sans", "Segoe UI", sans-serif';
  const urlW = ctx.measureText(opts.urlText).width;
  ctx.fillText(opts.urlText, Math.max(28, width - 28 - urlW), 22);
}

function drawPanel(
  ctx: CanvasRenderingContext2D,
  opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    target: SandboxGifExportTarget;
    capture: HTMLCanvasElement;
  },
) {
  const { x, y, width, height, target, capture } = opts;
  const captureX = x + PANEL_PAD;
  const captureY = y + PANEL_PAD + PANEL_META_HEIGHT;
  const captureWidth = width - PANEL_PAD * 2;
  const captureHeight = height - PANEL_PAD * 2 - PANEL_META_HEIGHT;

  ctx.save();
  roundedRectPath(ctx, x, y, width, height, PANEL_RADIUS);
  ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
  ctx.fill();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.22)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "rgba(125, 211, 252, 0.96)";
  ctx.font = '700 11px "IBM Plex Sans", "Segoe UI", sans-serif';
  ctx.textBaseline = "top";
  ctx.fillText(target.company.toUpperCase(), x + PANEL_PAD, y + 12);

  const modelLine =
    target.modelName.length > 24 ? `${target.modelName.slice(0, 23)}...` : target.modelName;
  ctx.fillStyle = "rgba(241, 245, 249, 0.98)";
  ctx.font = '700 23px "Sora", "Avenir Next", "Segoe UI", sans-serif';
  ctx.fillText(modelLine, x + PANEL_PAD, y + 27);

  const blockLabel = `${target.blockCount.toLocaleString()} blocks`;
  ctx.font = '600 11px "IBM Plex Sans", "Segoe UI", sans-serif';
  const badgeWidth = Math.ceil(ctx.measureText(blockLabel).width + 16);
  const badgeX = x + width - PANEL_PAD - badgeWidth;
  const badgeY = y + 14;
  roundedRectPath(ctx, badgeX, badgeY, badgeWidth, 22, 11);
  ctx.fillStyle = "rgba(30, 41, 59, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.34)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(226, 232, 240, 0.96)";
  ctx.fillText(blockLabel, badgeX + 8, badgeY + 5);

  ctx.save();
  roundedRectPath(ctx, captureX, captureY, captureWidth, captureHeight, CAPTURE_RADIUS);
  ctx.clip();
  ctx.drawImage(capture, captureX, captureY, captureWidth, captureHeight);
  ctx.restore();

  ctx.strokeStyle = "rgba(148, 163, 184, 0.3)";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, captureX, captureY, captureWidth, captureHeight, CAPTURE_RADIUS);
  ctx.stroke();
}

async function buildGifBlob(
  targets: SandboxGifExportTarget[],
  promptText: string,
  onProgress?: (done: number, total: number) => void,
) {
  const count = targets.length;
  const width = count === 1 ? EXPORT_SIZE_SINGLE.width : EXPORT_SIZE_COMPARE.width;
  const height = count === 1 ? EXPORT_SIZE_SINGLE.height : EXPORT_SIZE_COMPARE.height;
  const panelBottom = EXPORT_MARGIN_BOTTOM;
  const panelGap = count === 1 ? 0 : PANEL_GAP;
  const panelWidth = (width - EXPORT_MARGIN_X * 2 - panelGap * (count - 1)) / count;

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = width;
  frameCanvas.height = height;
  const frameCtx = frameCanvas.getContext("2d");
  if (!frameCtx) throw new Error("Unable to initialize export canvas");
  frameCtx.imageSmoothingEnabled = true;
  frameCtx.imageSmoothingQuality = "high";

  type WorkerOut =
    | { type: "ready" }
    | { type: "ack"; frameIndex: number }
    | { type: "result"; bytes: ArrayBuffer }
    | { type: "error"; message: string };

  const worker = new Worker(new URL("./gifenc.worker.ts", import.meta.url));
  const ackWaiters = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();

  let resolveReady: (() => void) | null = null;
  let rejectReady: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = (e) => reject(e);
  });

  let resolveResult: ((bytes: ArrayBuffer) => void) | null = null;
  let rejectResult: ((err: Error) => void) | null = null;
  const resultPromise = new Promise<ArrayBuffer>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = (e) => reject(e);
  });

  const failAll = (err: Error) => {
    for (const waiter of ackWaiters.values()) waiter.reject(err);
    ackWaiters.clear();
    rejectReady?.(err);
    rejectResult?.(err);
  };

  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ready") {
      resolveReady?.();
      return;
    }

    if (msg.type === "ack") {
      const waiter = ackWaiters.get(msg.frameIndex);
      if (waiter) {
        ackWaiters.delete(msg.frameIndex);
        waiter.resolve();
      }
      return;
    }

    if (msg.type === "result") {
      resolveResult?.(msg.bytes);
      return;
    }

    if (msg.type === "error") {
      failAll(new Error(msg.message || "GIF worker error"));
    }
  };
  worker.onerror = () => {
    failAll(new Error("GIF worker crashed"));
  };

  worker.postMessage({ type: "start" });
  await readyPromise;

  const title = count === 2 ? "MineBench Comparison" : "MineBench Build";
  const urlText = "minebench.ai";
  const normalizedPrompt = promptText.replace(/\s+/g, " ").trim();
  frameCtx.font = '500 13px "IBM Plex Sans", "Segoe UI", sans-serif';
  const promptLines = wrapTextLines(
    frameCtx,
    `Prompt: ${normalizedPrompt || "sandbox prompt"}`,
    width - 56,
    2,
  );
  const panelTop = Math.max(86, 54 + promptLines.length * 16 + 22);
  const panelHeight = height - panelTop - panelBottom;
  const header = { title, promptLines, urlText };

  try {
    const inFlight: Promise<void>[] = [];
    let completed = 0;

    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const t = FRAME_COUNT > 1 ? frame / (FRAME_COUNT - 1) : 0;
      const angle = t * Math.PI * 2;
      drawBaseBackdrop(frameCtx, width, height, header);

      for (let idx = 0; idx < targets.length; idx += 1) {
        const target = targets[idx];
        const panelX = EXPORT_MARGIN_X + idx * (panelWidth + panelGap);
        const panelY = panelTop;
        const captureWidth = Math.floor(panelWidth - PANEL_PAD * 2);
        const captureHeight = Math.floor(panelHeight - PANEL_PAD * 2 - PANEL_META_HEIGHT);
        const capture = target.viewerRef.current?.captureFrame({
          rotationY: angle,
          width: Math.max(1, Math.round(captureWidth * CAPTURE_SUPERSAMPLE)),
          height: Math.max(1, Math.round(captureHeight * CAPTURE_SUPERSAMPLE)),
        });
        if (!capture) {
          throw new Error("One of the viewers is not ready for export");
        }

        drawPanel(frameCtx, {
          x: panelX,
          y: panelY,
          width: panelWidth,
          height: panelHeight,
          target,
          capture,
        });
      }

      const pixels = frameCtx.getImageData(0, 0, width, height).data;
      const buffer = pixels.buffer;
      const ackPromise = new Promise<void>((resolve, reject) => {
        ackWaiters.set(frame, { resolve, reject });
      });
      worker.postMessage(
        {
          type: "frame",
          frameIndex: frame,
          width,
          height,
          delay: FRAME_DELAY_MS,
          pixels: buffer,
        },
        [buffer],
      );
      const tracked = ackPromise.then(() => {
        completed += 1;
        onProgress?.(completed, FRAME_COUNT);
      });
      inFlight.push(tracked);

      if (inFlight.length >= MAX_IN_FLIGHT_FRAMES) {
        await inFlight[0];
        inFlight.shift();
      }

      if (frame % YIELD_EVERY_FRAMES === 0) {
        await waitForNextPaint();
      }
    }

    if (inFlight.length) await Promise.all(inFlight);

    worker.postMessage({ type: "finish" });
    const bytes = await resultPromise;
    return new Blob([bytes], { type: "image/gif" });
  } finally {
    worker.terminate();
  }
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function SandboxGifExportButton({ targets, promptText, label, iconOnly, className }: Props) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const hasTargets = targets.length > 0;

  async function handleExport() {
    if (!hasTargets || exporting) return;
    const notReady = targets.some((target) => !target.viewerRef.current?.hasBuild());
    if (notReady) {
      setError("Viewer is still loading. Try again in a second.");
      return;
    }
    setExporting(true);
    setError(null);
    setProgress({ done: 0, total: FRAME_COUNT });
    await waitForNextPaint();
    try {
      const blob = await buildGifBlob(targets, promptText ?? "", (done, total) => {
        if (done === total || done % 2 === 0) setProgress({ done, total });
      });
      const modelToken = targets.map((t) => sanitizeFilePart(t.modelName) || "model").join("-vs-");
      const promptToken = sanitizeFilePart(promptText ?? "sandbox");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const typeToken = targets.length === 2 ? "compare" : "build";
      const fileName = `minebench-${typeToken}-${modelToken}-${promptToken}-${stamp}.gif`;
      triggerDownload(blob, fileName);
    } catch (err) {
      const message = err instanceof Error ? err.message : "GIF export failed";
      setError(message);
      console.error("[gif-export]", err);
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }

  const displayLabel = exporting
    ? progress
      ? `Rendering ${Math.max(0, progress.done)}/${progress.total}`
      : "Rendering..."
    : (label ?? (targets.length === 2 ? "Export comparison GIF" : "Export GIF"));
  const buttonTitle = error ?? displayLabel;

  return (
    <button
      type="button"
      aria-label={displayLabel}
      title={buttonTitle}
      onClick={() => void handleExport()}
      disabled={!hasTargets || exporting}
      className={`${iconOnly ? "mb-btn mb-btn-ghost h-8 w-8 rounded-full border border-border/70 bg-bg/55 p-0 text-muted hover:text-fg" : "mb-btn mb-btn-ghost h-9 rounded-full border border-border/70 bg-bg/55 px-3 text-xs tracking-[0.01em] backdrop-blur-sm sm:text-sm"} disabled:cursor-not-allowed disabled:opacity-40 ${className ?? ""}`}
    >
      <span className={`inline-flex items-center ${iconOnly ? "justify-center" : "gap-1.5"}`}>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className={`h-4 w-4 ${exporting ? "animate-pulse" : ""}`}
        >
          <path
            d="M4 8a3 3 0 0 1 3-3h1.4l1.1-1.6A2 2 0 0 1 11.2 2h1.6a2 2 0 0 1 1.7.9L15.6 5H17a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <circle cx="12" cy="12" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
        </svg>
        {iconOnly ? null : <span>{displayLabel}</span>}
      </span>
    </button>
  );
}
