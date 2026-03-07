import { applyPalette, quantize } from "gifenc";
import { createOffsetGifEncoder } from "./gifenc-offset";

type WorkerStart = { type: "start" };
type WorkerPalette = { type: "palette"; samples: ArrayBuffer[] };
type WorkerFrame = {
  type: "frame";
  frameIndex: number;
  width: number;
  height: number;
  delay: number;
  pixels: ArrayBuffer;
};
type WorkerFinish = { type: "finish" };
type WorkerCancel = { type: "cancel" };

type InMessage = WorkerStart | WorkerPalette | WorkerFrame | WorkerFinish | WorkerCancel;

type OutReady = { type: "ready" };
type OutAck = { type: "ack"; frameIndex: number };
type OutResult = { type: "result"; bytes: ArrayBuffer };
type OutError = { type: "error"; message: string };
type OutMessage = OutReady | OutAck | OutResult | OutError;

type Encoder = ReturnType<typeof createOffsetGifEncoder>;
type Palette = number[][];

let encoder: Encoder | null = null;
let globalPalette: Palette | null = null;
let expectedWidth = 0;
let expectedHeight = 0;
let transparentIndex = -1;
let previousPixels: Uint8ClampedArray | null = null;

function reset() {
  encoder = null;
  globalPalette = null;
  expectedWidth = 0;
  expectedHeight = 0;
  transparentIndex = -1;
  previousPixels = null;
}

function pickLeastUsedPaletteIndex(indexed: Uint8Array, paletteSize: number): number {
  if (paletteSize < 2) return -1;
  const counts = new Uint32Array(paletteSize);
  for (let i = 0; i < indexed.length; i += 1) {
    counts[indexed[i] ?? 0] += 1;
  }

  let best = 0;
  let bestCount = counts[0] ?? 0;
  for (let i = 1; i < counts.length; i += 1) {
    const n = counts[i] ?? 0;
    if (n < bestCount) {
      best = i;
      bestCount = n;
    }
  }
  return best;
}

function nearestOpaqueIndex(
  palette: Palette,
  excluded: number,
  r: number,
  g: number,
  b: number,
  cache: Map<number, number>,
): number {
  const key = (r << 16) | (g << 8) | b;
  const cached = cache.get(key);
  if (typeof cached === "number") return cached;

  let best = excluded === 0 ? 1 : 0;
  if (best >= palette.length) best = 0;
  let bestDist = Number.POSITIVE_INFINITY;

  for (let i = 0; i < palette.length; i += 1) {
    if (i === excluded) continue;
    const color = palette[i];
    if (!color) continue;
    const dr = (color[0] ?? 0) - r;
    const dg = (color[1] ?? 0) - g;
    const db = (color[2] ?? 0) - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
      if (dist === 0) break;
    }
  }

  cache.set(key, best);
  return best;
}

function post(msg: OutMessage, transfer?: Transferable[]) {
  const workerSelf = self as unknown as {
    postMessage: (message: OutMessage, transfer?: Transferable[]) => void;
  };
  if (transfer && transfer.length > 0) {
    workerSelf.postMessage(msg, transfer);
    return;
  }
  workerSelf.postMessage(msg);
}

function buildPaletteFromSamples(samples: ArrayBuffer[]) {
  const totalBytes = samples.reduce((sum, sample) => sum + sample.byteLength, 0);
  if (totalBytes <= 0) return null;

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const sample of samples) {
    const view = new Uint8ClampedArray(sample);
    merged.set(view, offset);
    offset += view.length;
  }

  return quantize(merged, 256) as Palette;
}

function findDirtyRect(
  pixels: Uint8ClampedArray,
  previous: Uint8ClampedArray,
  width: number,
  height: number,
) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0, px = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, px += 4) {
      const changed =
        pixels[px] !== previous[px] ||
        pixels[px + 1] !== previous[px + 1] ||
        pixels[px + 2] !== previous[px + 2] ||
        pixels[px + 3] !== previous[px + 3];
      if (!changed) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function extractSubPixels(
  pixels: Uint8ClampedArray,
  frameWidth: number,
  rect: { x: number; y: number; width: number; height: number },
) {
  const subPixels = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const srcStart = ((rect.y + y) * frameWidth + rect.x) * 4;
    const srcEnd = srcStart + rect.width * 4;
    subPixels.set(pixels.subarray(srcStart, srcEnd), y * rect.width * 4);
  }
  return subPixels;
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === "start") {
      reset();
      encoder = createOffsetGifEncoder();
      post({ type: "ready" });
      return;
    }

    if (msg.type === "cancel") {
      reset();
      post({ type: "ready" });
      return;
    }

    if (msg.type === "palette") {
      globalPalette = buildPaletteFromSamples(msg.samples);
      return;
    }

    if (msg.type === "frame") {
      if (!encoder) throw new Error("Encoder not initialized");
      if (!expectedWidth) expectedWidth = msg.width;
      if (!expectedHeight) expectedHeight = msg.height;
      if (msg.width !== expectedWidth || msg.height !== expectedHeight) {
        throw new Error("Frame size mismatch");
      }

      const pixels = new Uint8ClampedArray(msg.pixels);
      if (!globalPalette) {
        globalPalette = quantize(pixels, 256) as Palette;
      }

      if (msg.frameIndex === 0 || !previousPixels || previousPixels.length !== pixels.length) {
        const firstIndex = applyPalette(pixels, globalPalette);
        if (transparentIndex < 0) {
          transparentIndex = pickLeastUsedPaletteIndex(firstIndex, globalPalette.length);
        }
        encoder.writeFrame(firstIndex, msg.width, msg.height, {
          palette: globalPalette,
          delay: msg.delay,
          repeat: msg.frameIndex === 0 ? 0 : undefined,
        });
        previousPixels = pixels.slice();
        post({ type: "ack", frameIndex: msg.frameIndex });
        return;
      }

      const dirtyRect = findDirtyRect(pixels, previousPixels, expectedWidth, expectedHeight);
      if (!dirtyRect) {
        const idleIndex = new Uint8Array([Math.max(0, transparentIndex)]);
        encoder.writeFrame(idleIndex, 1, 1, {
          x: 0,
          y: 0,
          delay: msg.delay,
          transparent: transparentIndex >= 0,
          transparentIndex: transparentIndex >= 0 ? transparentIndex : undefined,
          dispose: transparentIndex >= 0 ? 1 : undefined,
        });
        previousPixels = pixels.slice();
        post({ type: "ack", frameIndex: msg.frameIndex });
        return;
      }

      const subPixels = extractSubPixels(pixels, expectedWidth, dirtyRect);
      const index = applyPalette(subPixels, globalPalette);
      let hasTransparentPixels = false;

      if (transparentIndex >= 0 && globalPalette.length > 1) {
        const remapCache = new Map<number, number>();
        for (let y = 0, idx = 0; y < dirtyRect.height; y += 1) {
          const subRowStart = y * dirtyRect.width * 4;
          const prevRowStart = ((dirtyRect.y + y) * expectedWidth + dirtyRect.x) * 4;
          for (let x = 0; x < dirtyRect.width; x += 1, idx += 1) {
            const subOffset = subRowStart + x * 4;
            const prevOffset = prevRowStart + x * 4;
            const unchanged =
              subPixels[subOffset] === previousPixels[prevOffset] &&
              subPixels[subOffset + 1] === previousPixels[prevOffset + 1] &&
              subPixels[subOffset + 2] === previousPixels[prevOffset + 2] &&
              subPixels[subOffset + 3] === previousPixels[prevOffset + 3];
            if (unchanged) {
              index[idx] = transparentIndex;
              hasTransparentPixels = true;
              continue;
            }

            if (index[idx] === transparentIndex) {
              index[idx] = nearestOpaqueIndex(
                globalPalette,
                transparentIndex,
                subPixels[subOffset] ?? 0,
                subPixels[subOffset + 1] ?? 0,
                subPixels[subOffset + 2] ?? 0,
                remapCache,
              );
            }
          }
        }
      }

      encoder.writeFrame(index, dirtyRect.width, dirtyRect.height, {
        x: dirtyRect.x,
        y: dirtyRect.y,
        delay: msg.delay,
        transparent: hasTransparentPixels,
        transparentIndex: hasTransparentPixels ? transparentIndex : undefined,
        dispose: hasTransparentPixels ? 1 : undefined,
      });
      previousPixels = pixels.slice();
      post({ type: "ack", frameIndex: msg.frameIndex });
      return;
    }

    if (msg.type === "finish") {
      if (!encoder) throw new Error("Encoder not initialized");
      encoder.finish();
      const bytes = encoder.bytes().slice().buffer;
      reset();
      post({ type: "result", bytes }, [bytes]);
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Worker error";
    reset();
    post({ type: "error", message });
  }
};

export {};
