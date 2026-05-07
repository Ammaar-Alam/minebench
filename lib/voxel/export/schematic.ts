import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getMinecraftBlockState } from "@/lib/voxel/export/blockStates";
import { NBT_TAG, NbtWriter } from "@/lib/voxel/export/nbt";
import type { VoxelBuild } from "@/lib/voxel/types";

export type VoxelSchematicExportStats = {
  width: number;
  height: number;
  length: number;
  volume: number;
  blockCount: number;
  paletteSize: number;
};

export type VoxelSchematicExport = {
  bytes: Uint8Array;
  stats: VoxelSchematicExportStats;
};

const SCHEMATIC_VERSION = 3;
const MINECRAFT_DATA_VERSION = 3465;
const MAX_SCHEMATIC_VOLUME = 32_000_000;

function encodeVarint(value: number, out: number[]) {
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    out.push(byte);
  } while (current !== 0);
}

function encodePaletteData(indices: Uint32Array, paletteSize: number): Uint8Array {
  if (paletteSize <= 128) {
    const bytes = new Uint8Array(indices.length);
    for (let i = 0; i < indices.length; i += 1) bytes[i] = indices[i] ?? 0;
    return bytes;
  }

  const out: number[] = [];
  for (const index of indices) encodeVarint(index, out);
  return Uint8Array.from(out);
}

export function buildSpongeSchematic(build: VoxelBuild, palette: BlockDefinition[]): VoxelSchematicExport {
  const allowed = new Set(palette.map((block) => block.id));
  const blocksByPosition = new Map<string, { x: number; y: number; z: number; type: string }>();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const block of build.blocks) {
    if (!allowed.has(block.type)) continue;
    const key = `${block.x},${block.y},${block.z}`;
    blocksByPosition.set(key, block);
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    minZ = Math.min(minZ, block.z);
    maxX = Math.max(maxX, block.x);
    maxY = Math.max(maxY, block.y);
    maxZ = Math.max(maxZ, block.z);
  }

  const blocks = Array.from(blocksByPosition.values());
  if (blocks.length === 0) throw new Error("No blocks to export");

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const length = maxZ - minZ + 1;
  const volume = width * height * length;
  if (!Number.isFinite(volume) || volume <= 0) throw new Error("Invalid schematic bounds");
  if (volume > MAX_SCHEMATIC_VOLUME) {
    throw new Error(`Minecraft export is too large (${volume.toLocaleString()} cells)`);
  }
  if (width > 0xffff || height > 0xffff || length > 0xffff) {
    throw new Error("Minecraft export dimensions exceed the Sponge schematic limit");
  }

  const blockStateCounts = new Map<string, number>();
  for (const block of blocks) {
    const state = getMinecraftBlockState(block.type);
    blockStateCounts.set(state, (blockStateCounts.get(state) ?? 0) + 1);
  }

  const states = Array.from(blockStateCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([state]) => state);
  const paletteStates = ["minecraft:air", ...states];
  const stateToIndex = new Map<string, number>();
  paletteStates.forEach((state, index) => stateToIndex.set(state, index));

  const dataIndices = new Uint32Array(volume);
  for (const block of blocks) {
    const state = getMinecraftBlockState(block.type);
    const paletteIndex = stateToIndex.get(state) ?? 0;
    const x = block.x - minX;
    const y = block.y - minY;
    const z = block.z - minZ;
    const index = x + z * width + y * width * length;
    dataIndices[index] = paletteIndex;
  }

  const writer = new NbtWriter();
  writer.namedCompound("", () => {
    writer.namedCompound("Schematic", () => {
      writer.namedInt("Version", SCHEMATIC_VERSION);
      writer.namedInt("DataVersion", MINECRAFT_DATA_VERSION);
      writer.namedShort("Width", width);
      writer.namedShort("Height", height);
      writer.namedShort("Length", length);
      writer.namedIntArray("Offset", [0, 0, 0]);
      writer.namedCompound("Metadata", () => {
        writer.namedString("Name", "MineBench Export");
        writer.namedString("Author", "MineBench");
        writer.namedLong("Date", Date.now());
        writer.namedEmptyList("RequiredMods", NBT_TAG.string);
        writer.namedInt("MineBenchBlockCount", blocks.length);
      });
      writer.namedCompound("Blocks", () => {
        writer.namedCompound("Palette", () => {
          paletteStates.forEach((state, index) => writer.namedInt(state, index));
        });
        writer.namedByteArray("Data", encodePaletteData(dataIndices, paletteStates.length));
        writer.namedEmptyList("BlockEntities", NBT_TAG.compound);
      });
      writer.namedEmptyList("Entities", NBT_TAG.compound);
    });
  });

  return {
    bytes: writer.toUint8Array(),
    stats: {
      width,
      height,
      length,
      volume,
      blockCount: blocks.length,
      paletteSize: paletteStates.length,
    },
  };
}
