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

let encoder: Encoder | null = null;
let globalPalette: ReturnType<typeof quantize> | null = null;
let expectedWidth = 0;
let expectedHeight = 0;

function reset() {
  encoder = null;
  globalPalette = null;
  expectedWidth = 0;
  expectedHeight = 0;
}

function post(msg: OutMessage, transfer?: Transferable[]) {
  if (transfer && transfer.length > 0) {
    self.postMessage(msg, transfer);
    return;
  }
  self.postMessage(msg);
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
        globalPalette = quantize(pixels, 256);
      }
      const index = applyPalette(pixels, globalPalette);
      encoder.writeFrame(index, msg.width, msg.height, {
        palette: globalPalette,
        delay: msg.delay,
        repeat: msg.frameIndex === 0 ? 0 : undefined,
      });
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
