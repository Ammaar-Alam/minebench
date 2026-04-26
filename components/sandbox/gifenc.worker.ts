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

const RESERVED_TRANSPARENT_COLOR: [number, number, number] = [11, 18, 32];

let encoder: Encoder | null = null;
let globalPalette: Palette | null = null;
let opaquePalette: Palette | null = null;
let expectedWidth = 0;
let expectedHeight = 0;
let transparentIndex = -1;
let previousIndex: Uint8Array | null = null;

function reset() {
  encoder = null;
  globalPalette = null;
  opaquePalette = null;
  expectedWidth = 0;
  expectedHeight = 0;
  transparentIndex = -1;
  previousIndex = null;
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

  return quantize(merged, 255) as Palette;
}

function installPalette(palette: Palette | null) {
  const opaque = palette && palette.length > 0 ? palette.slice(0, 255) : [[0, 0, 0]];
  // reserve one transparent slot so real pixels never get remapped into trails
  globalPalette = [...opaque, RESERVED_TRANSPARENT_COLOR];
  opaquePalette = opaque;
  transparentIndex = opaque.length;
}

function findDirtyRect(
  indexed: Uint8Array,
  previous: Uint8Array,
  width: number,
  height: number,
) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0, px = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, px += 1) {
      if (indexed[px] === previous[px]) continue;
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

function extractSubIndex(
  indexed: Uint8Array,
  frameWidth: number,
  rect: { x: number; y: number; width: number; height: number },
) {
  const subIndex = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const srcStart = (rect.y + y) * frameWidth + rect.x;
    const srcEnd = srcStart + rect.width;
    subIndex.set(indexed.subarray(srcStart, srcEnd), y * rect.width);
  }
  return subIndex;
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
      installPalette(buildPaletteFromSamples(msg.samples));
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
      if (!globalPalette || !opaquePalette) {
        installPalette(quantize(pixels, 255) as Palette);
      }
      const palette = globalPalette;
      const colorPalette = opaquePalette;
      if (!palette || !colorPalette) throw new Error("Palette not initialized");

      const indexed = applyPalette(pixels, colorPalette);

      if (msg.frameIndex === 0 || !previousIndex || previousIndex.length !== indexed.length) {
        encoder.writeFrame(indexed, msg.width, msg.height, {
          palette,
          delay: msg.delay,
          repeat: msg.frameIndex === 0 ? 0 : undefined,
        });
        previousIndex = indexed.slice();
        post({ type: "ack", frameIndex: msg.frameIndex });
        return;
      }

      const dirtyRect = findDirtyRect(indexed, previousIndex, expectedWidth, expectedHeight);
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
        previousIndex = indexed.slice();
        post({ type: "ack", frameIndex: msg.frameIndex });
        return;
      }

      const index = extractSubIndex(indexed, expectedWidth, dirtyRect);
      let hasTransparentPixels = false;

      if (transparentIndex >= 0) {
        for (let y = 0, idx = 0; y < dirtyRect.height; y += 1) {
          const prevRowStart = (dirtyRect.y + y) * expectedWidth + dirtyRect.x;
          for (let x = 0; x < dirtyRect.width; x += 1, idx += 1) {
            const prevOffset = prevRowStart + x;
            if (indexed[prevOffset] === previousIndex[prevOffset]) {
              index[idx] = transparentIndex;
              hasTransparentPixels = true;
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
      previousIndex = indexed.slice();
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
