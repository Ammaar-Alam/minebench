import { getRenderKind } from "@/lib/blocks/registry";
import { getMinecraftBlockState } from "@/lib/voxel/export/blockStates";

export type VoxelExportMaterial = {
  blockId: string;
  materialName: string;
  baseColorFactor: [number, number, number, number];
  emissiveFactor: [number, number, number];
  alphaMode: "OPAQUE" | "BLEND" | "MASK";
  doubleSided: boolean;
  minecraftBlockState: string;
};

const BLOCK_COLORS: Record<string, number> = {
  stone: 0x878c90,
  cobblestone: 0x72767a,
  oak_planks: 0xb9874f,
  bricks: 0x9d4f3e,
  stone_bricks: 0x7d8288,
  mossy_stone_bricks: 0x637457,
  cracked_stone_bricks: 0x70757a,
  granite: 0x9c6553,
  diorite: 0xc4c5c0,
  andesite: 0x858987,
  deepslate: 0x4a4a4f,
  spruce_planks: 0x7b5630,
  birch_planks: 0xc4aa71,
  dark_oak_planks: 0x4b2f1d,
  oak_log: 0x8b6137,
  spruce_log: 0x5d4329,
  birch_log: 0xc1b995,
  quartz_block: 0xdcd7cb,
  smooth_stone: 0xa5a7a6,
  sandstone: 0xd6c484,
  red_sandstone: 0xb3653d,
  nether_bricks: 0x321d25,
  prismarine: 0x5d9d90,
  terracotta: 0xa65f3f,
  white_concrete: 0xd8dbd2,
  grass_block: 0x67a846,
  dirt: 0x8a5a38,
  sand: 0xd8c383,
  oak_leaves: 0x4f8c3c,
  water: 0x3f76e4,
  gravel: 0x838383,
  clay: 0xa8b2bd,
  snow: 0xf0f6f8,
  ice: 0x9dc7f3,
  packed_ice: 0x79a9dc,
  moss_block: 0x5c7b34,
  flowering_azalea_leaves: 0x5f8f45,
  lava: 0xf06b1d,
  soul_sand: 0x4b352d,
  netherrack: 0x703333,
  white_wool: 0xe4e4dc,
  black_wool: 0x1f2226,
  red_wool: 0xa4362d,
  blue_wool: 0x334fb2,
  green_wool: 0x546d25,
  yellow_wool: 0xd8b837,
  orange_wool: 0xe27a2e,
  purple_wool: 0x7a3daa,
  brown_wool: 0x6b4729,
  gray_wool: 0x555b60,
  light_gray_wool: 0x9aa0a1,
  cyan_wool: 0x2d8a9a,
  light_blue_wool: 0x5f9ed8,
  lime_wool: 0x76b83a,
  magenta_wool: 0xb54ec3,
  pink_wool: 0xd77aa8,
  red_concrete: 0x8f2f24,
  blue_concrete: 0x2c3c89,
  green_concrete: 0x4b6726,
  yellow_concrete: 0xd8b93b,
  black_concrete: 0x0f1013,
  copper_block: 0xb76e49,
  oxidized_copper: 0x5e9f94,
  obsidian: 0x241a34,
  crying_obsidian: 0x382054,
  sea_lantern: 0xb7d5c5,
  redstone_block: 0xb3211e,
  emerald_block: 0x35b66a,
  diamond_block: 0x62d6d3,
  lapis_block: 0x284a9d,
  glass: 0xc8eef7,
  tinted_glass: 0x4a4056,
  glowstone: 0xf2c260,
  iron_block: 0xd2d5d6,
  gold_block: 0xf0c44d,
  amethyst_block: 0x9b6ad3,
  ancient_debris: 0x5b433b,
};

function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

export function getVoxelExportMaterial(blockId: string): VoxelExportMaterial {
  const renderKind = getRenderKind(blockId) ?? "opaque";
  const alpha =
    blockId === "water" ? 0.62 : renderKind === "transparent" ? 0.78 : renderKind === "cutout" ? 0.92 : 1;
  const rgb = hexToRgb(BLOCK_COLORS[blockId] ?? 0x9aa0a6);
  const emissive =
    renderKind === "emissive"
      ? blockId === "lava"
        ? ([0.95, 0.28, 0.04] as [number, number, number])
        : ([0.45, 0.36, 0.18] as [number, number, number])
      : ([0, 0, 0] as [number, number, number]);

  return {
    blockId,
    materialName: blockId,
    baseColorFactor: [rgb[0], rgb[1], rgb[2], alpha],
    emissiveFactor: emissive,
    alphaMode: renderKind === "transparent" ? "BLEND" : renderKind === "cutout" ? "MASK" : "OPAQUE",
    doubleSided: renderKind === "transparent" || renderKind === "cutout",
    minecraftBlockState: getMinecraftBlockState(blockId),
  };
}
