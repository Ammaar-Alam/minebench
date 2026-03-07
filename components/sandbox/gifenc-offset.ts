import lzwEncode from "gifenc/src/lzwEncode.js";
import createStream from "gifenc/src/stream.js";

type Palette = number[][];

type WriteFrameOptions = {
  x?: number;
  y?: number;
  transparent?: boolean;
  transparentIndex?: number;
  delay?: number;
  palette?: Palette | null;
  repeat?: number;
  colorDepth?: number;
  dispose?: number;
};

type EncoderOptions = {
  initialCapacity?: number;
};

// Adapted from gifenc so we can place delta frames at non-zero offsets.
export function createOffsetGifEncoder(options: EncoderOptions = {}) {
  const { initialCapacity = 4096 } = options;
  const stream = createStream(initialCapacity);
  const accum = new Uint8Array(256);
  const htab = new Int32Array(5003);
  const codetab = new Int32Array(5003);
  let hasInit = false;

  return {
    writeFrame(index: ArrayLike<number>, width: number, height: number, opts: WriteFrameOptions = {}) {
      const {
        x = 0,
        y = 0,
        transparent = false,
        transparentIndex = 0x00,
        delay = 0,
        palette = null,
        repeat = 0,
        colorDepth = 8,
        dispose = -1,
      } = opts;

      const first = !hasInit;
      if (first) {
        if (!palette) throw new Error("First frame must include a palette");
        writeHeader(stream);
        encodeLogicalScreenDescriptor(stream, width, height, palette, colorDepth);
        encodeColorTable(stream, palette);
        if (repeat >= 0) encodeNetscapeExt(stream, repeat);
        hasInit = true;
      }

      const frameX = Math.max(0, Math.floor(x));
      const frameY = Math.max(0, Math.floor(y));
      const frameWidth = Math.max(1, Math.floor(width));
      const frameHeight = Math.max(1, Math.floor(height));
      const delayTime = Math.round(delay / 10);

      encodeGraphicControlExt(
        stream,
        dispose,
        delayTime,
        transparent,
        transparentIndex,
      );

      const useLocalColorTable = Boolean(palette) && !first;
      encodeImageDescriptor(
        stream,
        frameX,
        frameY,
        frameWidth,
        frameHeight,
        useLocalColorTable ? palette : null,
      );
      if (useLocalColorTable && palette) encodeColorTable(stream, palette);
      encodePixels(stream, index, frameWidth, frameHeight, colorDepth, accum, htab, codetab);
    },
    finish() {
      stream.writeByte(0x3b);
    },
    bytes() {
      return stream.bytes();
    },
  };
}

function writeHeader(stream: ReturnType<typeof createStream>) {
  writeUTFBytes(stream, "GIF89a");
}

function encodeGraphicControlExt(
  stream: ReturnType<typeof createStream>,
  dispose: number,
  delay: number,
  transparent: boolean,
  transparentIndex: number,
) {
  stream.writeByte(0x21);
  stream.writeByte(0xf9);
  stream.writeByte(4);

  let transparentFlag = transparent;
  let index = transparentIndex;
  if (index < 0) {
    index = 0x00;
    transparentFlag = false;
  }

  let disp = transparentFlag ? 2 : 0;
  if (dispose >= 0) disp = dispose & 7;
  disp <<= 2;

  stream.writeByte(disp | (transparentFlag ? 1 : 0));
  writeUInt16(stream, delay);
  stream.writeByte(index || 0x00);
  stream.writeByte(0);
}

function encodeLogicalScreenDescriptor(
  stream: ReturnType<typeof createStream>,
  width: number,
  height: number,
  palette: Palette,
  colorDepth = 8,
) {
  const globalColorTableFlag = 1;
  const sortFlag = 0;
  const globalColorTableSize = colorTableSize(palette.length) - 1;
  const fields =
    (globalColorTableFlag << 7) |
    ((colorDepth - 1) << 4) |
    (sortFlag << 3) |
    globalColorTableSize;
  writeUInt16(stream, width);
  writeUInt16(stream, height);
  stream.writeBytes([fields, 0, 0]);
}

function encodeNetscapeExt(stream: ReturnType<typeof createStream>, repeat: number) {
  stream.writeByte(0x21);
  stream.writeByte(0xff);
  stream.writeByte(11);
  writeUTFBytes(stream, "NETSCAPE2.0");
  stream.writeByte(3);
  stream.writeByte(1);
  writeUInt16(stream, repeat);
  stream.writeByte(0);
}

function encodeColorTable(stream: ReturnType<typeof createStream>, palette: Palette) {
  const colorTableLength = 1 << colorTableSize(palette.length);
  for (let i = 0; i < colorTableLength; i += 1) {
    const color = i < palette.length ? palette[i] ?? [0, 0, 0] : [0, 0, 0];
    stream.writeByte(color[0] ?? 0);
    stream.writeByte(color[1] ?? 0);
    stream.writeByte(color[2] ?? 0);
  }
}

function encodeImageDescriptor(
  stream: ReturnType<typeof createStream>,
  x: number,
  y: number,
  width: number,
  height: number,
  localPalette: Palette | null,
) {
  stream.writeByte(0x2c);
  writeUInt16(stream, x);
  writeUInt16(stream, y);
  writeUInt16(stream, width);
  writeUInt16(stream, height);

  if (localPalette) {
    const palSize = colorTableSize(localPalette.length) - 1;
    stream.writeByte(0x80 | palSize);
    return;
  }

  stream.writeByte(0);
}

function encodePixels(
  stream: ReturnType<typeof createStream>,
  index: ArrayLike<number>,
  width: number,
  height: number,
  colorDepth: number,
  accum: Uint8Array,
  htab: Int32Array,
  codetab: Int32Array,
) {
  lzwEncode(width, height, index, colorDepth, stream, accum, htab, codetab);
}

function writeUInt16(stream: ReturnType<typeof createStream>, value: number) {
  stream.writeByte(value & 0xff);
  stream.writeByte((value >> 8) & 0xff);
}

function writeUTFBytes(stream: ReturnType<typeof createStream>, text: string) {
  for (let i = 0; i < text.length; i += 1) {
    stream.writeByte(text.charCodeAt(i));
  }
}

function colorTableSize(length: number) {
  return Math.max(Math.ceil(Math.log2(length)), 1);
}
