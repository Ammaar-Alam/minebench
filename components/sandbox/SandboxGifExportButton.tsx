"use client";

import type { RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import {
  getSandboxGifExportPanelGrid,
  getSandboxSocialSafeInsets,
  type SandboxGifExportLayoutFormat,
  type SandboxSocialSafeInsets,
} from "@/lib/sandbox/gifExportLayout";
import {
  DEFAULT_MEDIA_EXPORT_PREFERENCE,
  getEffectiveMediaExportFileType,
  type MediaExportFileType,
  type MediaExportFraming,
  type MediaExportQuality,
  readMediaExportPreference,
} from "@/lib/sandbox/mediaExportPreference";

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
  embedded?: boolean;
  className?: string;
  cancelKey?: string;
};

type GifExportFormat = "wide" | "vertical";
type GifExportLayoutFormat = SandboxGifExportLayoutFormat;

const GIF_DELAY_TICK_MS = 10;
const MAX_IN_FLIGHT_FRAMES = 4;
const YIELD_EVERY_FRAMES = 24;
const COMPARISON_FRAME_COUNT = 108;
const SINGLE_FRAME_COUNT = 135;
const COMPARISON_FRAME_DELAY_MS = 40;
const SINGLE_FRAME_DELAY_MS = 40;
const CREATOR_FRAME_RATE = 30;
const CREATOR_FRAME_COUNT = 180;
const CREATOR_DURATION_MS = 6000;
const SOCIAL_SAFE_CAMERA_DISTANCE_SCALE = 1.18;
const SOCIAL_SAFE_WATERMARK_FONT_SIZE = 16;
const COMPARISON_PALETTE_SAMPLE_COUNT = 12;
const SINGLE_PALETTE_SAMPLE_COUNT = 16;
const COMPARISON_PALETTE_SAMPLE_LONG_EDGE = 640;
const SINGLE_PALETTE_SAMPLE_LONG_EDGE = 720;
const BYTES_PER_MB = 1024 * 1024;
const LOSSLESS_OPT_MIN_INPUT_BYTES = 6 * BYTES_PER_MB;
const LOSSLESS_OPT_MAX_INPUT_BYTES = 10 * BYTES_PER_MB;
const LOSSLESS_OPT_MIN_ABS_SAVINGS_BYTES = 256 * 1024;
const LOSSLESS_OPT_MIN_RELATIVE_SAVINGS = 0.03;
const GIF_TARGET_MAX_BYTES = 15 * BYTES_PER_MB;
const LOSSY_OPT_LEVELS = [12, 20, 28, 35] as const;
const EXPORT_RENDER_PROFILES: Record<
  GifExportLayoutFormat,
  ReadonlyArray<{ width: number; height: number }>
> = {
  single: [
    { width: 1080, height: 1215 },
    { width: 960, height: 1080 },
    { width: 840, height: 945 },
  ],
  wide: [
    { width: 1440, height: 810 },
    { width: 1280, height: 720 },
    { width: 960, height: 540 },
    { width: 720, height: 405 },
  ],
  vertical: [
    { width: 810, height: 1440 },
    { width: 720, height: 1280 },
    { width: 640, height: 1138 },
    { width: 540, height: 960 },
  ],
};
const CREATOR_EXPORT_RENDER_PROFILES: Record<
  GifExportLayoutFormat,
  ReadonlyArray<{ width: number; height: number }>
> = {
  single: [
    { width: 1080, height: 1920 },
    { width: 900, height: 1600 },
    { width: 810, height: 1440 },
  ],
  wide: [
    { width: 1920, height: 1080 },
    { width: 1600, height: 900 },
    { width: 1440, height: 810 },
  ],
  vertical: [
    { width: 1080, height: 1920 },
    { width: 900, height: 1600 },
    { width: 810, height: 1440 },
  ],
};
const MULTI_ROW_WIDE_RENDER_PROFILES = [
  { width: 1440, height: 1080 },
  { width: 1280, height: 960 },
  { width: 960, height: 720 },
  { width: 800, height: 600 },
] as const;
const CREATOR_MULTI_ROW_WIDE_RENDER_PROFILES = [
  { width: 1920, height: 1440 },
  { width: 1600, height: 1200 },
  { width: 1440, height: 1080 },
] as const;

const EXPORT_MARGIN_X = 22;
const EXPORT_MARGIN_BOTTOM = 22;
const PANEL_GAP = 16;
const PANEL_PAD = 12;
const PANEL_META_HEIGHT = 62;
const PANEL_RADIUS = 18;
const CAPTURE_RADIUS = 14;
const MIN_EXPORT_PANEL_HEIGHT = 220;
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
    x: number;
    right: number;
    titleY: number;
    promptY: number;
    socialSafe: boolean;
  };
  safeInsets: SandboxSocialSafeInsets | null;
  cameraDistanceScale: number;
};
type ExportRect = ExportLayout["panelRects"][number];

type GifRenderProfile = { width: number; height: number };
type GifExportRuntime = {
  frameCount: number;
  frameRate: number;
  frameDelayMs: number;
  frameDelaysMs: number[];
  paletteSampleCount: number;
  paletteSampleLongEdge: number;
  socialSafe: boolean;
};
type GifExportRotationBases = number[];

function getExportRenderProfiles(
  format: GifExportLayoutFormat,
  targetCount: number,
  quality: MediaExportQuality,
): ReadonlyArray<GifRenderProfile> {
  if (format === "wide" && targetCount > 2) {
    return quality === "creator"
      ? CREATOR_MULTI_ROW_WIDE_RENDER_PROFILES
      : MULTI_ROW_WIDE_RENDER_PROFILES;
  }
  return quality === "creator"
    ? CREATOR_EXPORT_RENDER_PROFILES[format]
    : EXPORT_RENDER_PROFILES[format];
}

function buildFrameDelaySchedule(frameCount: number, frameDelayMs: number): number[] {
  let elapsedTicks = 0;
  return Array.from({ length: frameCount }, (_, frame) => {
    const nextElapsedTicks = Math.round(((frame + 1) * frameDelayMs) / GIF_DELAY_TICK_MS);
    const delayTicks = Math.max(1, nextElapsedTicks - elapsedTicks);
    elapsedTicks = nextElapsedTicks;
    return delayTicks * GIF_DELAY_TICK_MS;
  });
}

function getExportRuntime(
  format: GifExportLayoutFormat,
  quality: MediaExportQuality,
  framing: MediaExportFraming,
): GifExportRuntime {
  const single = format === "single";
  const creator = quality === "creator";
  const frameCount = creator
    ? CREATOR_FRAME_COUNT
    : single
      ? SINGLE_FRAME_COUNT
      : COMPARISON_FRAME_COUNT;
  const frameRate = creator
    ? CREATOR_FRAME_RATE
    : 1000 / (single ? SINGLE_FRAME_DELAY_MS : COMPARISON_FRAME_DELAY_MS);
  const frameDelayMs = creator ? CREATOR_DURATION_MS / CREATOR_FRAME_COUNT : 1000 / frameRate;
  return {
    frameCount,
    frameRate,
    frameDelayMs,
    frameDelaysMs: buildFrameDelaySchedule(frameCount, frameDelayMs),
    paletteSampleCount: single ? SINGLE_PALETTE_SAMPLE_COUNT : COMPARISON_PALETTE_SAMPLE_COUNT,
    paletteSampleLongEdge: single ? SINGLE_PALETTE_SAMPLE_LONG_EDGE : COMPARISON_PALETTE_SAMPLE_LONG_EDGE,
    socialSafe: quality === "creator" && framing === "social-safe" && format !== "wide",
  };
}

function getExportRotationBases(targets: SandboxGifExportTarget[]): GifExportRotationBases {
  return targets.map((target) => target.viewerRef.current?.getRotationY() ?? 0);
}

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

function createAbortError() {
  return new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
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

function fitTextWithEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || ctx.measureText(clean).width <= maxWidth) return clean;

  const suffix = "...";
  let lo = 0;
  let hi = clean.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${clean.slice(0, mid).replace(/\s+$/g, "")}${suffix}`;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }

  return `${clean.slice(0, lo).replace(/\s+$/g, "")}${suffix}`;
}

function capPromptLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  maxLines: number,
  maxWidth: number,
) {
  const lineLimit = Math.max(1, maxLines);
  if (lines.length <= lineLimit) return lines;

  const visible = lines.slice(0, lineLimit);
  const overflowText = lines.slice(lineLimit - 1).join(" ");
  visible[lineLimit - 1] = fitTextWithEllipsis(ctx, overflowText, maxWidth);
  return visible;
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
  format: GifExportLayoutFormat,
  framing: MediaExportFraming,
): ExportLayout {
  const safeCount = Math.max(1, Math.min(4, count));
  const panelGap = safeCount === 1 ? 0 : PANEL_GAP;
  const grid = getSandboxGifExportPanelGrid(safeCount, format);
  const socialSafe = framing === "social-safe" && format !== "wide";
  const safeInsets = socialSafe ? getSandboxSocialSafeInsets(width, height) : null;
  const headerX = safeInsets?.left ?? 28;
  const headerRight = width - (safeInsets?.right ?? 28);
  const titleY = safeInsets?.top ?? 18;
  const promptY = socialSafe ? titleY + 42 : 60;
  ctx.font = HEADER_PROMPT_FONT;
  const normalizedPrompt = promptText.replace(/\s+/g, " ").trim();
  const promptMaxWidth = Math.max(1, headerRight - headerX);
  const allPromptLines = wrapTextLines(ctx, `Prompt: ${normalizedPrompt || "sandbox prompt"}`, promptMaxWidth);
  const maxPanelTop =
    height -
    EXPORT_MARGIN_BOTTOM -
    panelGap * (grid.rows - 1) -
    MIN_EXPORT_PANEL_HEIGHT * grid.rows;
  // free-form prompts still need room for viewers
  const maxPromptLines = Math.floor(
    (maxPanelTop - promptY - 24) / HEADER_PROMPT_LINE_HEIGHT,
  );
  const promptLines = capPromptLines(ctx, allPromptLines, maxPromptLines, promptMaxWidth);
  const panelTop = Math.max(
    socialSafe ? promptY + 24 : 104,
    promptY + promptLines.length * HEADER_PROMPT_LINE_HEIGHT + 24,
  );
  const panelWidth =
    (width - EXPORT_MARGIN_X * 2 - panelGap * (grid.columns - 1)) / grid.columns;
  const panelHeight =
    (height - panelTop - EXPORT_MARGIN_BOTTOM - panelGap * (grid.rows - 1)) / grid.rows;
  const panelRects: ExportLayout["panelRects"] = [];

  for (let row = 0; row < grid.rows; row += 1) {
    const columnsInRow = grid.rowColumns[row] ?? grid.columns;
    const rowWidth = panelWidth * columnsInRow + panelGap * Math.max(0, columnsInRow - 1);
    const rowX = EXPORT_MARGIN_X + (width - EXPORT_MARGIN_X * 2 - rowWidth) / 2;

    for (let column = 0; column < columnsInRow && panelRects.length < safeCount; column += 1) {
      panelRects.push({
        x: rowX + column * (panelWidth + panelGap),
        y: panelTop + row * (panelHeight + panelGap),
        width: panelWidth,
        height: panelHeight,
      });
    }
  }

  return {
    width,
    height,
    panelRects,
    header: {
      title: safeCount > 1 ? "MineBench Comparison" : "MineBench Build",
      promptLines,
      urlText: "minebench.ai",
      x: headerX,
      right: headerRight,
      titleY,
      promptY,
      socialSafe,
    },
    safeInsets,
    cameraDistanceScale: socialSafe ? SOCIAL_SAFE_CAMERA_DISTANCE_SCALE : 1,
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

function getPaletteSampleSize(profile: GifRenderProfile, longEdge: number) {
  const scale = longEdge / Math.max(profile.width, profile.height);
  return {
    width: Math.max(1, Math.round(profile.width * scale)),
    height: Math.max(1, Math.round(profile.height * scale)),
  };
}

function shouldTryGifOptimization(input: Blob, enforceTarget = false) {
  return (
    input.size >= LOSSLESS_OPT_MIN_INPUT_BYTES &&
    (enforceTarget || input.size <= LOSSLESS_OPT_MAX_INPUT_BYTES)
  );
}

async function optimizeGifBlobForDownload(
  input: Blob,
  signal?: AbortSignal,
  opts: { enforceTarget?: boolean } = {},
): Promise<Blob> {
  throwIfAborted(signal);
  if (!shouldTryGifOptimization(input, opts.enforceTarget)) return input;

  try {
    const [{ default: gifsicle }, inputBytes] = await Promise.all([
      import("gifsicle-wasm-browser"),
      input.arrayBuffer(),
    ]);
    throwIfAborted(signal);

    const runOptimize = async (command: string) => {
      throwIfAborted(signal);
      const outputs = await gifsicle.run({
        input: [{ file: inputBytes.slice(0), name: "in.gif" }],
        command: [`${command} in.gif -o /out/out.gif`],
        isStrict: true,
      });
      throwIfAborted(signal);
      return outputs.find((file) => file.name.toLowerCase().endsWith(".gif")) ?? null;
    };

    const optimized = await runOptimize("-O2");
    let best = optimized && optimized.size < input.size ? optimized : input;

    if (opts.enforceTarget && best.size > GIF_TARGET_MAX_BYTES) {
      for (const lossyLevel of LOSSY_OPT_LEVELS) {
        const lossy = await runOptimize(`-O2 --lossy=${lossyLevel}`);
        if (lossy && lossy.size < best.size) best = lossy;
        if (lossy && lossy.size <= GIF_TARGET_MAX_BYTES) return lossy;
      }

      throw new Error(
        `GIF stayed above 15 MB after optimization (${(best.size / BYTES_PER_MB).toFixed(1)} MB)`,
      );
    }

    const savings = input.size - best.size;
    const relativeSavings = savings / Math.max(1, input.size);
    const meaningful =
      savings >= LOSSLESS_OPT_MIN_ABS_SAVINGS_BYTES &&
      relativeSavings >= LOSSLESS_OPT_MIN_RELATIVE_SAVINGS;
    return meaningful ? best : input;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.warn("[gif-export] optimize skipped", err);
    if (opts.enforceTarget && input.size > GIF_TARGET_MAX_BYTES) {
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
    x: number;
    right: number;
    titleY: number;
    promptY: number;
    socialSafe: boolean;
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
  ctx.fillText(opts.title, opts.x, opts.titleY);

  ctx.fillStyle = "rgba(203, 213, 225, 0.95)";
  ctx.font = HEADER_PROMPT_FONT;
  for (let i = 0; i < opts.promptLines.length; i += 1) {
    ctx.fillText(
      opts.promptLines[i] ?? "",
      opts.x,
      opts.promptY + i * HEADER_PROMPT_LINE_HEIGHT,
    );
  }

  ctx.fillStyle = opts.socialSafe
    ? "rgba(148, 163, 184, 0.9)"
    : "rgba(100, 116, 139, 0.85)";
  ctx.font = `${opts.socialSafe ? 600 : 500} ${
    opts.socialSafe ? SOCIAL_SAFE_WATERMARK_FONT_SIZE : 11
  }px "IBM Plex Sans", "Segoe UI", sans-serif`;
  const urlW = ctx.measureText(opts.urlText).width;
  ctx.fillText(opts.urlText, Math.max(opts.x, opts.right - urlW), opts.titleY + 4);
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
    captureRect: ExportRect;
    contentBounds: { left: number; right: number } | null;
  },
) {
  const { x, y, width, height, target, capture, captureRect, contentBounds } = opts;
  const { x: captureX, y: captureY, width: captureWidth, height: captureHeight } = captureRect;
  const metaLeft = Math.max(x + PANEL_PAD, contentBounds?.left ?? x + PANEL_PAD);
  const metaRight = Math.min(x + width - PANEL_PAD, contentBounds?.right ?? x + width - PANEL_PAD);

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
  ctx.fillText(target.company.toUpperCase(), metaLeft, y + 12);

  const blockLabel = `${target.blockCount.toLocaleString()} blocks`;
  ctx.font = '600 11px "IBM Plex Sans", "Segoe UI", sans-serif';
  const badgeWidth = Math.ceil(ctx.measureText(blockLabel).width + 16);
  const badgeX = metaRight - badgeWidth;
  const badgeY = y + 14;
  roundedRectPath(ctx, badgeX, badgeY, badgeWidth, 22, 11);
  ctx.fillStyle = "rgba(30, 41, 59, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.34)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(226, 232, 240, 0.96)";
  ctx.fillText(blockLabel, badgeX + 8, badgeY + 5);

  ctx.fillStyle = "rgba(241, 245, 249, 0.98)";
  ctx.font = '700 23px "Sora", "Avenir Next", "Segoe UI", sans-serif';
  const modelLine = fitTextWithEllipsis(
    ctx,
    target.modelName,
    Math.max(1, metaRight - metaLeft - badgeWidth - 8),
  );
  ctx.fillText(modelLine, metaLeft, y + 27);

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
  rotationBases: GifExportRotationBases,
  angle: number,
) {
  drawBaseBackdrop(ctx, layout.width, layout.height, layout.header);
  const contentBounds = layout.safeInsets
    ? { left: layout.safeInsets.left, right: layout.width - layout.safeInsets.right }
    : null;

  for (let idx = 0; idx < targets.length; idx += 1) {
    const target = targets[idx];
    const panel = layout.panelRects[idx];
    if (!panel) continue;
    const captureRect = {
      x: Math.round(panel.x + PANEL_PAD),
      y: Math.round(panel.y + PANEL_PAD + PANEL_META_HEIGHT),
      width: Math.max(1, Math.round(panel.width - PANEL_PAD * 2)),
      height: Math.max(1, Math.round(panel.height - PANEL_PAD * 2 - PANEL_META_HEIGHT)),
    };
    const capture = target.viewerRef.current?.captureFrame({
      rotationY: (rotationBases[idx] ?? 0) + angle,
      width: captureRect.width,
      height: captureRect.height,
      distanceScale: layout.cameraDistanceScale,
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
      captureRect,
      contentBounds,
    });
  }
}

async function buildPaletteSamples(
  targets: SandboxGifExportTarget[],
  format: GifExportLayoutFormat,
  profile: GifRenderProfile,
  runtime: GifExportRuntime,
  rotationBases: GifExportRotationBases,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const sampleSize = getPaletteSampleSize(profile, runtime.paletteSampleLongEdge);
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
    runtime.socialSafe ? "social-safe" : "full",
  );
  const samples: ArrayBuffer[] = [];
  const sampleFrames = buildPaletteSampleFrames(runtime.frameCount, runtime.paletteSampleCount);

  for (let idx = 0; idx < sampleFrames.length; idx += 1) {
    throwIfAborted(signal);
    const frame = sampleFrames[idx];
    const t = runtime.frameCount > 0 ? frame / runtime.frameCount : 0;
    renderCompositeFrame(sampleCtx, layout, targets, rotationBases, t * Math.PI * 2);
    const pixels = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    samples.push(pixels.buffer);
    if (idx > 0 && idx % 4 === 0) {
      await waitForNextPaint();
      throwIfAborted(signal);
    }
  }

  return samples;
}

async function buildGifBlob(
  targets: SandboxGifExportTarget[],
  promptText: string,
  format: GifExportLayoutFormat,
  profile: GifRenderProfile,
  runtime: GifExportRuntime,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const { width, height } = profile;

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = width;
  frameCanvas.height = height;
  const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
  if (!frameCtx) throw new Error("Unable to initialize export canvas");
  frameCtx.imageSmoothingEnabled = true;
  frameCtx.imageSmoothingQuality = "high";
  const rotationBases = getExportRotationBases(targets);

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
  throwIfAborted(signal);

  const paletteSamples = await buildPaletteSamples(targets, format, profile, runtime, rotationBases, signal);
  throwIfAborted(signal);
  if (paletteSamples.length > 0) {
    worker.postMessage({ type: "palette", samples: paletteSamples }, paletteSamples);
  }

  const layout = buildExportLayout(
    frameCtx,
    targets.length,
    width,
    height,
    promptText,
    format,
    runtime.socialSafe ? "social-safe" : "full",
  );

  try {
    const inFlight: Promise<void>[] = [];
    let completed = 0;

    for (let frame = 0; frame < runtime.frameCount; frame += 1) {
      throwIfAborted(signal);
      const t = runtime.frameCount > 0 ? frame / runtime.frameCount : 0;
      renderCompositeFrame(frameCtx, layout, targets, rotationBases, t * Math.PI * 2);

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
          delay: runtime.frameDelaysMs[frame] ?? runtime.frameDelayMs,
          pixels: buffer,
        },
        [buffer],
      );
      const tracked = ackPromise.then(() => {
        completed += 1;
        onProgress?.(completed, runtime.frameCount);
      });
      inFlight.push(tracked);

      if (inFlight.length >= MAX_IN_FLIGHT_FRAMES) {
        await inFlight[0];
        inFlight.shift();
        throwIfAborted(signal);
      }

      if (frame > 0 && frame % YIELD_EVERY_FRAMES === 0) {
        await waitForNextPaint();
        throwIfAborted(signal);
      }
    }

    if (inFlight.length) await Promise.all(inFlight);
    throwIfAborted(signal);

    worker.postMessage({ type: "finish" });
    const bytes = await resultPromise;
    throwIfAborted(signal);
    return new Blob([bytes], { type: "image/gif" });
  } finally {
    worker.terminate();
  }
}

async function buildMp4Blob(
  targets: SandboxGifExportTarget[],
  promptText: string,
  format: GifExportLayoutFormat,
  profile: GifRenderProfile,
  runtime: GifExportRuntime,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, canEncodeVideo } =
    await import("mediabunny");
  throwIfAborted(signal);

  const { width, height } = profile;
  const quality = new Quality("very-high");
  const supported = await canEncodeVideo("avc", {
    width,
    height,
    quality,
    latencyMode: "quality",
  });
  if (!supported) {
    throw new Error("MP4 export isn’t supported in this browser. Choose GIF in Account settings.");
  }

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = width;
  frameCanvas.height = height;
  const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: false });
  if (!frameCtx) throw new Error("Unable to initialize MP4 export canvas");
  frameCtx.imageSmoothingEnabled = true;
  frameCtx.imageSmoothingQuality = "high";

  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(frameCanvas, {
    codec: "avc",
    quality,
    latencyMode: "quality",
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: runtime.frameRate });
  const rotationBases = getExportRotationBases(targets);
  const layout = buildExportLayout(
    frameCtx,
    targets.length,
    width,
    height,
    promptText,
    format,
    runtime.socialSafe ? "social-safe" : "full",
  );
  const frameDuration = 1 / runtime.frameRate;

  try {
    await output.start();
    for (let frame = 0; frame < runtime.frameCount; frame += 1) {
      throwIfAborted(signal);
      const t = frame / runtime.frameCount;
      renderCompositeFrame(frameCtx, layout, targets, rotationBases, t * Math.PI * 2);
      await videoSource.add(frame / runtime.frameRate, frameDuration);
      onProgress?.(frame + 1, runtime.frameCount);

      if (frame > 0 && frame % YIELD_EVERY_FRAMES === 0) {
        await waitForNextPaint();
        throwIfAborted(signal);
      }
    }

    videoSource.close();
    await output.finalize();
    throwIfAborted(signal);
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("MP4 export finished without video data");
    return new Blob([buffer], { type: "video/mp4" });
  } catch (error) {
    if (output.state !== "finalized" && output.state !== "canceled") {
      await output.cancel().catch(() => undefined);
    }
    throw error;
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
      aria-label="Export layout"
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
        const label = value === "wide" ? "Wide" : "Vertical";
        return (
          <button
            key={value}
            type="button"
            disabled={disabled}
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => onChange(value)}
            className={`grid place-items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-45 ${
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

export function SandboxGifExportButton({ targets, promptText, label, iconOnly, embedded, className, cancelKey }: Props) {
  const tooltipId = useId();
  const [exporting, setExporting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [format, setFormat] = useState<GifExportFormat>("wide");
  const [preference, setPreference] = useState(DEFAULT_MEDIA_EXPORT_PREFERENCE);
  const [activeFileType, setActiveFileType] = useState<MediaExportFileType | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const hasTargets = targets.length > 0;
  const canChooseFormat = targets.length > 1;
  const exportFormat: GifExportLayoutFormat = canChooseFormat ? format : "single";

  useEffect(() => {
    const saved = readMediaExportPreference();
    setPreference(saved);
    if (saved.quality === "creator") setFormat("vertical");
  }, []);

  useEffect(() => {
    exportAbortRef.current?.abort();
  }, [cancelKey]);

  async function handleExport() {
    if (!hasTargets || exporting) return;
    const notReady = targets.some((target) => !target.viewerRef.current?.hasBuild());
    if (notReady) {
      setError("Viewer is still loading. Try again in a second.");
      return;
    }
    const exportPreference = readMediaExportPreference();
    const fileType = getEffectiveMediaExportFileType(exportPreference);
    setPreference(exportPreference);
    setActiveFileType(fileType);
    setExporting(true);
    setOptimizing(false);
    setError(null);
    const abortController = new AbortController();
    exportAbortRef.current = abortController;
    await waitForNextPaint();
    try {
      const profiles = getExportRenderProfiles(
        exportFormat,
        targets.length,
        exportPreference.quality,
      );
      const runtime = getExportRuntime(
        exportFormat,
        exportPreference.quality,
        exportPreference.framing,
      );
      setProgress({ done: 0, total: runtime.frameCount });
      let finalBlob: Blob | null = null;

      if (fileType === "mp4") {
        for (let idx = 0; idx < profiles.length; idx += 1) {
          const profile = profiles[idx] ?? profiles[profiles.length - 1];
          setProgress({ done: 0, total: runtime.frameCount });
          try {
            finalBlob = await buildMp4Blob(
              targets,
              promptText ?? "",
              exportFormat,
              profile,
              runtime,
              (done, total) => {
                if (done === total || done % 2 === 0) setProgress({ done, total });
              },
              abortController.signal,
            );
            break;
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            if (idx === profiles.length - 1) throw err;
            console.warn("[media-export] MP4 profile skipped", profile, err);
            await waitForNextPaint();
            throwIfAborted(abortController.signal);
          }
        }
      } else {
        let smallestBlob: Blob | null = null;
        const enforceSizeTarget = exportPreference.quality === "standard";

        for (let idx = 0; idx < profiles.length; idx += 1) {
          const profile = profiles[idx] ?? profiles[profiles.length - 1];
          setOptimizing(false);
          setProgress({ done: 0, total: runtime.frameCount });

          let blob: Blob;
          try {
            blob = await buildGifBlob(
              targets,
              promptText ?? "",
              exportFormat,
              profile,
              runtime,
              (done, total) => {
                if (done === total || done % 2 === 0) setProgress({ done, total });
              },
              abortController.signal,
            );
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            if (idx === profiles.length - 1) throw err;
            console.warn("[media-export] GIF profile skipped", profile, err);
            await waitForNextPaint();
            throwIfAborted(abortController.signal);
            continue;
          }

          if (
            enforceSizeTarget &&
            blob.size > GIF_TARGET_MAX_BYTES &&
            idx < profiles.length - 1
          ) {
            await waitForNextPaint();
            throwIfAborted(abortController.signal);
            continue;
          }

          smallestBlob = blob;
          const enforceTarget =
            enforceSizeTarget && blob.size > GIF_TARGET_MAX_BYTES && idx === profiles.length - 1;
          const shouldOptimize = shouldTryGifOptimization(blob, enforceTarget);
          if (shouldOptimize) {
            setOptimizing(true);
            setProgress(null);
          }

          const optimizedBlob = await optimizeGifBlobForDownload(blob, abortController.signal, {
            enforceTarget,
          });
          if (optimizedBlob.size < smallestBlob.size) smallestBlob = optimizedBlob;
          finalBlob = optimizedBlob;
          break;
        }

        if (!finalBlob) finalBlob = smallestBlob;
      }
      if (!finalBlob) {
        throw new Error(`${fileType.toUpperCase()} export failed`);
      }

      const modelToken = targets
        .map((target) => sanitizeFilePart(target.modelName) || "model")
        .join("-vs-")
        .slice(0, 120)
        .replace(/-+$/g, "");
      const promptToken = sanitizeFilePart(promptText ?? "sandbox");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const typeToken = targets.length > 1 ? "compare" : "build";
      const formatToken =
        exportFormat === "vertical" ||
        (exportFormat === "single" && exportPreference.quality === "creator")
          ? "vertical"
          : exportFormat === "single"
            ? "viewer"
            : "wide";
      const fileName = `minebench-${typeToken}-${formatToken}-${modelToken}-${promptToken}-${stamp}.${fileType}`;
      throwIfAborted(abortController.signal);
      triggerDownload(finalBlob, fileName);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Export failed";
      setError(message);
      console.error("[media-export]", err);
    } finally {
      if (exportAbortRef.current === abortController) {
        exportAbortRef.current = null;
      }
      setOptimizing(false);
      setExporting(false);
      setProgress(null);
      setActiveFileType(null);
    }
  }

  const preferredFileType = getEffectiveMediaExportFileType(preference);
  const displayedFileType = activeFileType ?? preferredFileType;
  const idleLabel = label ?? (targets.length > 1 ? "Export comparison GIF" : "Export GIF");
  const fileTypeLabel =
    displayedFileType === "mp4" ? idleLabel.replace(/\bGIF\b/g, "MP4") : idleLabel;
  const displayLabel = exporting
    ? optimizing
      ? "Optimizing..."
      : progress
        ? `${displayedFileType === "mp4" ? "Encoding" : "Rendering"} ${Math.max(0, progress.done)}/${progress.total}`
        : displayedFileType === "mp4"
          ? "Encoding..."
          : "Rendering..."
    : fileTypeLabel;
  const buttonTitle = error ?? displayLabel;
  const busy = exporting || optimizing;
  const isUnavailable = !hasTargets;
  const shouldKeepTooltipVisible = Boolean(iconOnly && (busy || error));
  const formatSelector = canChooseFormat ? (
    <GifFormatSelector
      format={format}
      disabled={busy}
      compact={iconOnly}
      embedded
      onChange={setFormat}
    />
  ) : null;

  const button = (
    <button
      type="button"
      aria-label={buttonTitle}
      aria-describedby={iconOnly && !embedded ? tooltipId : undefined}
      aria-busy={busy || undefined}
      aria-disabled={isUnavailable || busy}
      title={iconOnly && !embedded ? undefined : buttonTitle}
      onClick={() => void handleExport()}
      disabled={isUnavailable}
      className={`inline-flex select-none items-center justify-center font-semibold text-fg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 motion-reduce:transition-none ${
        embedded ? "mb-btn mb-btn-ghost rounded-md border border-border/70 bg-bg/55" : "rounded-full"
      } ${
        iconOnly
          ? "h-7 w-7 p-0 text-muted hover:bg-fg/7 hover:text-fg"
          : "h-8 gap-1.5 px-3 text-xs tracking-[0.01em] hover:bg-fg/7 sm:px-3.5 sm:text-sm"
      } ${busy ? "cursor-progress opacity-75" : ""} disabled:cursor-not-allowed disabled:opacity-40 ${className ?? ""}`}
    >
      <span className={`inline-flex items-center ${iconOnly ? "justify-center" : "gap-1.5"}`}>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className={`h-4 w-4 ${exporting ? "animate-pulse motion-reduce:animate-none" : ""}`}
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

  if (embedded) return button;

  if (!iconOnly) {
    return (
      <div className="inline-flex h-9 items-center rounded-full border border-border/70 bg-bg/55 p-0.5 shadow-[0_18px_44px_-28px_rgba(4,11,31,0.95)] backdrop-blur-sm">
        {formatSelector}
        {formatSelector ? <span className="mx-1 h-4 w-px bg-border/45" aria-hidden="true" /> : null}
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
        className={`pointer-events-none absolute right-[calc(100%+0.55rem)] top-1/2 z-[40] w-max max-w-[min(16rem,calc(100vw-8rem))] -translate-y-1/2 rounded-full border border-border/80 bg-[linear-gradient(180deg,rgba(8,13,30,0.98),rgba(5,9,22,0.96))] px-3 py-1.5 text-right text-[11px] text-fg shadow-[0_18px_44px_-24px_rgba(4,11,31,0.9)] backdrop-blur-md transition duration-150 motion-reduce:transition-none ${shouldKeepTooltipVisible ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0 group-hover/gif-export:translate-x-0 group-hover/gif-export:opacity-100 group-focus-within/gif-export:translate-x-0 group-focus-within/gif-export:opacity-100"}`}
      >
        <span className="block truncate">{buttonTitle}</span>
      </div>
      {formatSelector}
      {formatSelector ? <span className="mx-1 h-3.5 w-px bg-border/45" aria-hidden="true" /> : null}
      {button}
    </div>
  );
}
