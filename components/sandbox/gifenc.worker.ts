import { GIFEncoder, applyPalette, quantize } from "gifenc";

type WorkerStart = { type: "start" };
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

type InMessage = WorkerStart | WorkerFrame | WorkerFinish | WorkerCancel;

type OutReady = { type: "ready" };
type OutAck = { type: "ack"; frameIndex: number };
type OutResult = { type: "result"; bytes: ArrayBuffer };
type OutError = { type: "error"; message: string };
type OutMessage = OutReady | OutAck | OutResult | OutError;

type Encoder = ReturnType<typeof GIFEncoder>;
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

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === "start") {
      reset();
      encoder = GIFEncoder();
      post({ type: "ready" });
      return;
    }

    if (msg.type === "cancel") {
      reset();
      post({ type: "ready" });
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
        // Global palette for stability and speed (reduces frame-to-frame color flicker).
        globalPalette = quantize(pixels, 256) as Palette;
      }

      const index = applyPalette(pixels, globalPalette);
      if (transparentIndex < 0) {
        transparentIndex = pickLeastUsedPaletteIndex(index, globalPalette.length);
      }

      if (msg.frameIndex === 0 || !previousPixels || previousPixels.length !== pixels.length) {
        encoder.writeFrame(index, msg.width, msg.height, {
          palette: globalPalette,
          delay: msg.delay,
          repeat: msg.frameIndex === 0 ? 0 : undefined,
        });
        previousPixels = pixels.slice();
        post({ type: "ack", frameIndex: msg.frameIndex });
        return;
      }

      let hasTransparentPixels = false;
      if (transparentIndex >= 0 && globalPalette.length > 1) {
        const remapCache = new Map<number, number>();
        for (let px = 0, idx = 0; px < pixels.length; px += 4, idx += 1) {
          const unchanged =
            pixels[px] === previousPixels[px] &&
            pixels[px + 1] === previousPixels[px + 1] &&
            pixels[px + 2] === previousPixels[px + 2] &&
            pixels[px + 3] === previousPixels[px + 3];
          if (unchanged) {
            index[idx] = transparentIndex;
            hasTransparentPixels = true;
            continue;
          }

          if (index[idx] === transparentIndex) {
            index[idx] = nearestOpaqueIndex(
              globalPalette,
              transparentIndex,
              pixels[px] ?? 0,
              pixels[px + 1] ?? 0,
              pixels[px + 2] ?? 0,
              remapCache,
            );
          }
        }
      }

      encoder.writeFrame(index, msg.width, msg.height, {
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
