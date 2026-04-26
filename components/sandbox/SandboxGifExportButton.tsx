"use client";

import type { RefObject } from "react";
import { useId, useState } from "react";
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

type GifExportFormat = "wide" | "vertical";

const TARGET_FPS = 60;
const FRAME_DELAY_MS = Math.round(1000 / TARGET_FPS);
const FRAME_COUNT = 160;
const GIF_DELAY_TICK_MS = 10;
const ROTATION_SLOWDOWN_FACTOR = 1.25;
const MAX_IN_FLIGHT_FRAMES = 6;
const YIELD_EVERY_FRAMES = 50;
const PALETTE_SAMPLE_COUNT = 18;
const PALETTE_SAMPLE_LONG_EDGE = 720;
const EXPORT_SIZE_WIDE = { width: 1920, height: 1080 };
const EXPORT_SIZE_VERTICAL = { width: 1080, height: 1920 };
const LOSSLESS_OPT_MIN_INPUT_BYTES = 6 * 1024 * 1024;
const LOSSLESS_OPT_LARGE_INPUT_BYTES = 10 * 1024 * 1024;
const LOSSLESS_OPT_ALWAYS_KEEP_BYTES = 15 * 1024 * 1024;
const LOSSLESS_OPT_MIN_ABS_SAVINGS_BYTES = 256 * 1024;
const LOSSLESS_OPT_MIN_RELATIVE_SAVINGS = 0.03;
const GIF_OPT_TARGET_MAX_BYTES = 15 * 1024 * 1024;
// keep post-processing light so color and motion stay stable
const LOSSY_OPT_LEVELS = [12, 20, 28, 35] as const;
const EXPORT_RENDER_PROFILES: Record<
  GifExportFormat,
  ReadonlyArray<{ width: number; height: number }>
> = {
  wide: [
    EXPORT_SIZE_WIDE,
    { width: 1600, height: 900 },
    { width: 1440, height: 810 },
    { width: 1280, height: 720 },
    { width: 960, height: 540 },
  ],
  vertical: [
    EXPORT_SIZE_VERTICAL,
    { width: 900, height: 1600 },
    { width: 810, height: 1440 },
    { width: 720, height: 1280 },
    { width: 640, height: 1138 },
    { width: 540, height: 960 },
  ],
};

const EXPORT_MARGIN_X = 22;
const EXPORT_MARGIN_BOTTOM = 22;
const PANEL_GAP = 16;
const PANEL_PAD = 12;
const PANEL_META_HEIGHT = 62;
const PANEL_RADIUS = 18;
const CAPTURE_RADIUS = 14;
const HEADER_PROMPT_FONT = '600 18px "IBM Plex Sans", "Segoe UI", sans-serif';
const HEADER_PROMPT_LINE_HEIGHT = 23;
const GIF_FORMATS: GifExportFormat[] = ["wide", "vertical"];

type ExportLayout = {
  width: number;
  height: number;
  panelRects: Array<{ x: number; y: number; width: number; height: number }>;
  header: {
    title: string;
    promptLines: string[];
    urlText: string;
  };
};

type GifRenderProfile = (typeof EXPORT_RENDER_PROFILES)[GifExportFormat][number];

function buildFrameDelaySchedule(frameCount: number, slowdownFactor: number): number[] {
  const baseDelayTicks = Math.max(1, Math.round(FRAME_DELAY_MS / GIF_DELAY_TICK_MS));
  const totalDelayTicks = Math.max(1, Math.round(frameCount * baseDelayTicks * slowdownFactor));
  const delays: number[] = [];
  let assignedTicks = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const nextAssignedTicks = Math.round(((frame + 1) * totalDelayTicks) / frameCount);
    const frameDelayTicks = Math.max(1, nextAssignedTicks - assignedTicks);
    delays.push(frameDelayTicks * GIF_DELAY_TICK_MS);
    assignedTicks = nextAssignedTicks;
  }

  return delays;
}

const FRAME_DELAYS_MS = buildFrameDelaySchedule(FRAME_COUNT, ROTATION_SLOWDOWN_FACTOR);

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

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const lines: string[] = [];

  let current = "";
  for (const word of words) {
    if (ctx.measureText(word).width > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }

      let chunk = "";
      for (const char of word) {
        const nextChunk = `${chunk}${char}`;
        if (chunk && ctx.measureText(nextChunk).width > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = nextChunk;
        }
      }
      current = chunk;
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || current === "") {
      current = next;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
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

function buildExportLayout(
  ctx: CanvasRenderingContext2D,
  count: number,
  width: number,
  height: number,
  promptText: string,
  format: GifExportFormat,
): ExportLayout {
  const panelGap = count === 1 ? 0 : PANEL_GAP;
  ctx.font = HEADER_PROMPT_FONT;
  const normalizedPrompt = promptText.replace(/\s+/g, " ").trim();
  const promptLines = wrapTextLines(
    ctx,
    `Prompt: ${normalizedPrompt || "sandbox prompt"}`,
    width - 56,
  );
  const panelTop = Math.max(104, 60 + promptLines.length * HEADER_PROMPT_LINE_HEIGHT + 24);
  const panelRects =
    format === "vertical"
      ? Array.from({ length: count }, (_, idx) => {
          const panelWidth = width - EXPORT_MARGIN_X * 2;
          const panelHeight =
            (height - panelTop - EXPORT_MARGIN_BOTTOM - panelGap * (count - 1)) / count;
          return {
            x: EXPORT_MARGIN_X,
            y: panelTop + idx * (panelHeight + panelGap),
            width: panelWidth,
            height: panelHeight,
          };
        })
      : Array.from({ length: count }, (_, idx) => {
          const panelWidth = (width - EXPORT_MARGIN_X * 2 - panelGap * (count - 1)) / count;
          const panelHeight = height - panelTop - EXPORT_MARGIN_BOTTOM;
          return {
            x: EXPORT_MARGIN_X + idx * (panelWidth + panelGap),
            y: panelTop,
            width: panelWidth,
            height: panelHeight,
          };
        });

  return {
    width,
    height,
    panelRects,
    header: {
      title: count === 2 ? "MineBench Comparison" : "MineBench Build",
      promptLines,
      urlText: "minebench.ai",
    },
  };
}

function buildPaletteSampleFrames(frameCount: number, sampleCount: number): number[] {
  const uniqueFrames = Math.max(1, frameCount - 1);
  const count = Math.min(sampleCount, uniqueFrames);
  const frames = new Set<number>();
  for (let i = 0; i < count; i += 1) {
    const frame = Math.min(uniqueFrames - 1, Math.floor((i * uniqueFrames) / count));
    frames.add(frame);
  }
  return Array.from(frames).sort((a, b) => a - b);
}

function getPaletteSampleSize(profile: GifRenderProfile) {
  const scale = PALETTE_SAMPLE_LONG_EDGE / Math.max(profile.width, profile.height);
  return {
    width: Math.max(1, Math.round(profile.width * scale)),
    height: Math.max(1, Math.round(profile.height * scale)),
  };
}

async function optimizeGifBlobForSize(input: Blob): Promise<Blob> {
  if (input.size < LOSSLESS_OPT_MIN_INPUT_BYTES) return input;

  try {
    const [{ default: gifsicle }, inputBytes] = await Promise.all([
      import("gifsicle-wasm-browser"),
      input.arrayBuffer(),
    ]);

    const runOptimize = async (command: string) => {
      const outputs = await gifsicle.run({
        input: [{ file: inputBytes.slice(0), name: "in.gif" }],
        command: [`${command} in.gif -o /out/out.gif`],
        isStrict: true,
      });
      return outputs.find((file) => file.name.toLowerCase().endsWith(".gif")) ?? null;
    };

    const primaryLevel = input.size >= LOSSLESS_OPT_LARGE_INPUT_BYTES ? "-O2" : "-O3";
    const lossyOptimizeLevel = input.size >= LOSSLESS_OPT_LARGE_INPUT_BYTES ? "-O2" : "-O3";
    let optimized = await runOptimize(primaryLevel);
    let best = optimized && optimized.size < input.size ? optimized : input;

    if (
      primaryLevel === "-O2" &&
      optimized &&
      optimized.size > GIF_OPT_TARGET_MAX_BYTES &&
      optimized.size < input.size
    ) {
      const tighter = await runOptimize("-O3");
      if (tighter && tighter.size < optimized.size) optimized = tighter;
      if (tighter && tighter.size < best.size) best = tighter;
    }

    if (!optimized && best === input) {
      if (input.size > GIF_OPT_TARGET_MAX_BYTES) {
        throw new Error(
          `GIF stayed above 15 MB after optimization (${(input.size / 1024 / 1024).toFixed(1)} MB)`,
        );
      }
      return input;
    }
    if (best.size > GIF_OPT_TARGET_MAX_BYTES) {
      for (const lossyLevel of LOSSY_OPT_LEVELS) {
        // use the least lossy setting that gets under the target
        const lossy = await runOptimize(`${lossyOptimizeLevel} --lossy=${lossyLevel}`);
        if (lossy && lossy.size < best.size) best = lossy;
        if (lossy && lossy.size <= GIF_OPT_TARGET_MAX_BYTES) return lossy;
      }

      throw new Error(
        `GIF stayed above 15 MB after optimization (${(best.size / 1024 / 1024).toFixed(1)} MB)`,
      );
    }

    if (input.size >= LOSSLESS_OPT_ALWAYS_KEEP_BYTES) {
      return best.size < input.size ? best : input;
    }

    const savings = input.size - best.size;
    const relativeSavings = savings / Math.max(1, input.size);
    const meaningful =
      savings >= LOSSLESS_OPT_MIN_ABS_SAVINGS_BYTES &&
      relativeSavings >= LOSSLESS_OPT_MIN_RELATIVE_SAVINGS;
    return meaningful ? best : input;
  } catch (err) {
    console.warn("[gif-export] optimize skipped", err);
    if (input.size > GIF_OPT_TARGET_MAX_BYTES) {
      throw err instanceof Error
        ? err
        : new Error("GIF optimization failed before it could fit under 15 MB");
    }
    return input;
  }
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

  ctx.fillStyle = "rgba(203, 213, 225, 0.95)";
  ctx.font = HEADER_PROMPT_FONT;
  const promptY = 60;
  for (let i = 0; i < opts.promptLines.length; i += 1) {
    ctx.fillText(opts.promptLines[i] ?? "", 28, promptY + i * HEADER_PROMPT_LINE_HEIGHT);
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
  const captureWidth = Math.max(1, width - PANEL_PAD * 2);
  const captureHeight = Math.max(1, height - PANEL_PAD * 2 - PANEL_META_HEIGHT);

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

function renderCompositeFrame(
  ctx: CanvasRenderingContext2D,
  layout: ExportLayout,
  targets: SandboxGifExportTarget[],
  angle: number,
) {
  drawBaseBackdrop(ctx, layout.width, layout.height, layout.header);

  for (let idx = 0; idx < targets.length; idx += 1) {
    const target = targets[idx];
    const panel = layout.panelRects[idx];
    if (!panel) continue;
    const captureWidth = Math.max(1, Math.round(panel.width - PANEL_PAD * 2));
    const captureHeight = Math.max(1, Math.round(panel.height - PANEL_PAD * 2 - PANEL_META_HEIGHT));
    const capture = target.viewerRef.current?.captureFrame({
      rotationY: angle,
      width: captureWidth,
      height: captureHeight,
    });
    if (!capture) {
      throw new Error("One of the viewers is not ready for export");
    }

    drawPanel(ctx, {
      x: panel.x,
      y: panel.y,
      width: panel.width,
      height: panel.height,
      target,
      capture,
    });
  }
}

async function buildPaletteSamples(
  targets: SandboxGifExportTarget[],
  format: GifExportFormat,
  profile: GifRenderProfile,
) {
  const sampleSize = getPaletteSampleSize(profile);
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = sampleSize.width;
  sampleCanvas.height = sampleSize.height;
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!sampleCtx) throw new Error("Unable to initialize palette sampler");
  sampleCtx.imageSmoothingEnabled = true;
  sampleCtx.imageSmoothingQuality = "high";

  // palette pass uses short prompt so model colors stay dominant
  const layout = buildExportLayout(
    sampleCtx,
    targets.length,
    sampleCanvas.width,
    sampleCanvas.height,
    "",
    format,
  );
  const samples: ArrayBuffer[] = [];
  const sampleFrames = buildPaletteSampleFrames(FRAME_COUNT, PALETTE_SAMPLE_COUNT);

  for (let idx = 0; idx < sampleFrames.length; idx += 1) {
    const frame = sampleFrames[idx];
    const t = FRAME_COUNT > 1 ? frame / (FRAME_COUNT - 1) : 0;
    renderCompositeFrame(sampleCtx, layout, targets, t * Math.PI * 2);
    const pixels = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    samples.push(pixels.buffer);
    if (idx > 0 && idx % 4 === 0) await waitForNextPaint();
  }

  return samples;
}

async function buildGifBlob(
  targets: SandboxGifExportTarget[],
  promptText: string,
  format: GifExportFormat,
  profile: GifRenderProfile,
  onProgress?: (done: number, total: number) => void,
) {
  const { width, height } = profile;

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = width;
  frameCanvas.height = height;
  const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
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

  const paletteSamples = await buildPaletteSamples(targets, format, profile);
  if (paletteSamples.length > 0) {
    worker.postMessage({ type: "palette", samples: paletteSamples }, paletteSamples);
  }

  const layout = buildExportLayout(frameCtx, targets.length, width, height, promptText, format);

  try {
    const inFlight: Promise<void>[] = [];
    let completed = 0;

    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const t = FRAME_COUNT > 1 ? frame / (FRAME_COUNT - 1) : 0;
      renderCompositeFrame(frameCtx, layout, targets, t * Math.PI * 2);

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
          delay: FRAME_DELAYS_MS[frame] ?? FRAME_DELAY_MS,
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

      if (frame > 0 && frame % YIELD_EVERY_FRAMES === 0) {
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
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}

function FormatIcon({ format }: { format: GifExportFormat }) {
  const rect =
    format === "wide"
      ? { x: 3.5, y: 7, width: 17, height: 10, rx: 2.2 }
      : { x: 7, y: 3.5, width: 10, height: 17, rx: 2.2 };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={rect.rx}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d={format === "wide" ? "M7 10h10M7 14h6" : "M10 7h4M10 11h4M10 15h3"}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.45"
      />
    </svg>
  );
}

function GifFormatSelector({
  format,
  disabled,
  compact,
  embedded,
  onChange,
}: {
  format: GifExportFormat;
  disabled: boolean;
  compact?: boolean;
  embedded?: boolean;
  onChange: (format: GifExportFormat) => void;
}) {
  return (
    <div
      role="group"
      aria-label="GIF format"
      className={`inline-flex shrink-0 items-center rounded-full text-muted ${
        embedded
          ? "p-0"
          : "border border-border/70 bg-bg/45 p-0.5 shadow-[0_12px_30px_-24px_rgba(4,11,31,0.9)] backdrop-blur-sm"
      } ${
        compact ? "h-7" : "h-8"
      }`}
    >
      {GIF_FORMATS.map((value) => {
        const active = format === value;
        const label = value === "wide" ? "Wide GIF" : "Vertical GIF";
        return (
          <button
            key={value}
            type="button"
            disabled={disabled}
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => onChange(value)}
            className={`grid place-items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 disabled:cursor-not-allowed disabled:opacity-45 ${
              compact ? "h-7 w-7" : "h-8 w-8"
            } ${
              active
                ? "bg-accent/15 text-accent ring-1 ring-accent/40 shadow-[0_8px_20px_-16px_hsl(var(--accent)_/_0.7)]"
                : "text-muted/75 hover:bg-fg/7 hover:text-fg"
            }`}
          >
            <FormatIcon format={value} />
          </button>
        );
      })}
    </div>
  );
}

export function SandboxGifExportButton({ targets, promptText, label, iconOnly, className }: Props) {
  const tooltipId = useId();
  const [exporting, setExporting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [format, setFormat] = useState<GifExportFormat>("wide");

  const hasTargets = targets.length > 0;

  async function handleExport() {
    if (!hasTargets || exporting) return;
    const notReady = targets.some((target) => !target.viewerRef.current?.hasBuild());
    if (notReady) {
      setError("Viewer is still loading. Try again in a second.");
      return;
    }
    setExporting(true);
    setOptimizing(false);
    setError(null);
    setProgress({ done: 0, total: FRAME_COUNT });
    await waitForNextPaint();
    try {
      const profiles = EXPORT_RENDER_PROFILES[format];
      let finalBlob: Blob | null = null;
      let lastError: unknown = null;

      for (let idx = 0; idx < profiles.length; idx += 1) {
        const profile = profiles[idx] ?? profiles[profiles.length - 1];
        setOptimizing(false);
        setProgress({ done: 0, total: FRAME_COUNT });

        const blob = await buildGifBlob(
          targets,
          promptText ?? "",
          format,
          profile,
          (done, total) => {
            if (done === total || done % 2 === 0) setProgress({ done, total });
          },
        );

        setOptimizing(true);
        setProgress(null);
        try {
          finalBlob = await optimizeGifBlobForSize(blob);
          break;
        } catch (err) {
          lastError = err;
          if (idx === profiles.length - 1) throw err;
          await waitForNextPaint();
        }
      }

      if (!finalBlob) {
        throw lastError instanceof Error ? lastError : new Error("GIF export failed");
      }

      const modelToken = targets.map((t) => sanitizeFilePart(t.modelName) || "model").join("-vs-");
      const promptToken = sanitizeFilePart(promptText ?? "sandbox");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const typeToken = targets.length === 2 ? "compare" : "build";
      const formatToken = format === "vertical" ? "vertical" : "wide";
      const fileName = `minebench-${typeToken}-${formatToken}-${modelToken}-${promptToken}-${stamp}.gif`;
      triggerDownload(finalBlob, fileName);
    } catch (err) {
      const message = err instanceof Error ? err.message : "GIF export failed";
      setError(message);
      console.error("[gif-export]", err);
    } finally {
      setOptimizing(false);
      setExporting(false);
      setProgress(null);
    }
  }

  const displayLabel = exporting
    ? optimizing
      ? "Optimizing..."
      : progress
        ? `Rendering ${Math.max(0, progress.done)}/${progress.total}`
        : "Rendering..."
    : (label ?? (targets.length === 2 ? "Export comparison GIF" : "Export GIF"));
  const buttonTitle = error ?? displayLabel;
  const busy = exporting || optimizing;
  const isUnavailable = !hasTargets;
  const shouldKeepTooltipVisible = Boolean(iconOnly && (busy || error));
  const formatSelector = (
    <GifFormatSelector
      format={format}
      disabled={busy}
      compact={iconOnly}
      embedded
      onChange={setFormat}
    />
  );

  const button = (
    <button
      type="button"
      aria-label={buttonTitle}
      aria-describedby={iconOnly ? tooltipId : undefined}
      aria-busy={busy || undefined}
      aria-disabled={isUnavailable || busy}
      title={iconOnly ? undefined : buttonTitle}
      onClick={() => void handleExport()}
      disabled={isUnavailable}
      className={`inline-flex select-none items-center justify-center rounded-full font-semibold text-fg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${
        iconOnly
          ? "h-7 w-7 p-0 text-muted hover:bg-fg/7 hover:text-fg"
          : `h-8 gap-1.5 px-3 text-xs tracking-[0.01em] hover:bg-fg/7 sm:px-3.5 sm:text-sm ${className ?? ""}`
      } ${busy ? "cursor-progress opacity-75" : ""} disabled:cursor-not-allowed disabled:opacity-40`}
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

  if (!iconOnly) {
    return (
      <div className="inline-flex h-9 items-center rounded-full border border-border/70 bg-bg/55 p-0.5 shadow-[0_18px_44px_-28px_rgba(4,11,31,0.95)] backdrop-blur-sm">
        {formatSelector}
        <span className="mx-1 h-4 w-px bg-border/45" aria-hidden="true" />
        {button}
      </div>
    );
  }

  return (
    <div className="group/gif-export relative inline-flex h-8 items-center rounded-full border border-border/70 bg-bg/55 p-0.5 shadow-[0_18px_44px_-28px_rgba(4,11,31,0.95)] backdrop-blur-sm">
      <div
        id={tooltipId}
        role="status"
        aria-live={busy ? "polite" : undefined}
        className={`pointer-events-none absolute right-[calc(100%+0.55rem)] top-1/2 z-[40] w-max max-w-[min(16rem,calc(100vw-8rem))] -translate-y-1/2 rounded-full border border-border/80 bg-[linear-gradient(180deg,rgba(8,13,30,0.98),rgba(5,9,22,0.96))] px-3 py-1.5 text-right text-[11px] text-fg shadow-[0_18px_44px_-24px_rgba(4,11,31,0.9)] backdrop-blur-md transition duration-150 ${shouldKeepTooltipVisible ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0 group-hover/gif-export:translate-x-0 group-hover/gif-export:opacity-100 group-focus-within/gif-export:translate-x-0 group-focus-within/gif-export:opacity-100"}`}
      >
        <span className="block truncate">{buttonTitle}</span>
      </div>
      {formatSelector}
      <span className="mx-1 h-3.5 w-px bg-border/45" aria-hidden="true" />
      {button}
    </div>
  );
}
