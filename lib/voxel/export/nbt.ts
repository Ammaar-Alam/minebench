const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;

type TagType =
  | typeof TAG_BYTE
  | typeof TAG_SHORT
  | typeof TAG_INT
  | typeof TAG_LONG
  | typeof TAG_BYTE_ARRAY
  | typeof TAG_STRING
  | typeof TAG_LIST
  | typeof TAG_COMPOUND
  | typeof TAG_INT_ARRAY;

export const NBT_TAG = {
  byte: TAG_BYTE,
  short: TAG_SHORT,
  int: TAG_INT,
  long: TAG_LONG,
  byteArray: TAG_BYTE_ARRAY,
  string: TAG_STRING,
  list: TAG_LIST,
  compound: TAG_COMPOUND,
  intArray: TAG_INT_ARRAY,
} as const;

export class NbtWriter {
  private readonly bytes: number[] = [];
  private readonly encoder = new TextEncoder();

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  private writeByteRaw(value: number) {
    this.bytes.push(value & 0xff);
  }

  private writeTagHeader(type: TagType, name: string) {
    this.writeByteRaw(type);
    this.writeStringRaw(name);
  }

  private writeStringRaw(value: string) {
    const encoded = this.encoder.encode(value);
    this.writeShortRaw(encoded.byteLength);
    for (const byte of encoded) this.writeByteRaw(byte);
  }

  private writeShortRaw(value: number) {
    this.writeByteRaw(value >> 8);
    this.writeByteRaw(value);
  }

  private writeIntRaw(value: number) {
    this.writeByteRaw(value >> 24);
    this.writeByteRaw(value >> 16);
    this.writeByteRaw(value >> 8);
    this.writeByteRaw(value);
  }

  private writeLongRaw(value: number | bigint) {
    let big = BigInt(value);
    if (big < 0) big = (1n << 64n) + big;
    for (let shift = 56n; shift >= 0; shift -= 8n) {
      this.writeByteRaw(Number((big >> shift) & 0xffn));
    }
  }

  namedCompound(name: string, writePayload: () => void) {
    this.writeTagHeader(TAG_COMPOUND, name);
    writePayload();
    this.writeByteRaw(TAG_END);
  }

  namedByte(name: string, value: number) {
    this.writeTagHeader(TAG_BYTE, name);
    this.writeByteRaw(value);
  }

  namedShort(name: string, value: number) {
    this.writeTagHeader(TAG_SHORT, name);
    this.writeShortRaw(value);
  }

  namedInt(name: string, value: number) {
    this.writeTagHeader(TAG_INT, name);
    this.writeIntRaw(value);
  }

  namedLong(name: string, value: number | bigint) {
    this.writeTagHeader(TAG_LONG, name);
    this.writeLongRaw(value);
  }

  namedString(name: string, value: string) {
    this.writeTagHeader(TAG_STRING, name);
    this.writeStringRaw(value);
  }

  namedByteArray(name: string, value: Uint8Array) {
    this.writeTagHeader(TAG_BYTE_ARRAY, name);
    this.writeIntRaw(value.byteLength);
    for (const byte of value) this.writeByteRaw(byte);
  }

  namedIntArray(name: string, value: number[]) {
    this.writeTagHeader(TAG_INT_ARRAY, name);
    this.writeIntRaw(value.length);
    for (const item of value) this.writeIntRaw(item);
  }

  namedEmptyList(name: string, childType: TagType) {
    this.writeTagHeader(TAG_LIST, name);
    this.writeByteRaw(childType);
    this.writeIntRaw(0);
  }
}
