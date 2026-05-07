const MINECRAFT_STATE_OVERRIDES: Record<string, string> = {
  snow: "minecraft:snow_block",
  oak_leaves: "minecraft:oak_leaves[persistent=true]",
  flowering_azalea_leaves: "minecraft:flowering_azalea_leaves[persistent=true]",
  water: "minecraft:water[level=0]",
  lava: "minecraft:lava[level=0]",
};

export function getMinecraftBlockState(blockId: string): string {
  const normalized = blockId.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!normalized) return "minecraft:air";
  return MINECRAFT_STATE_OVERRIDES[normalized] ?? `minecraft:${normalized}`;
}
