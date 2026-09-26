import { ADVANCED_PALETTE, BlockDefinition, SIMPLE_PALETTE } from "@/lib/blocks/palettes";

const defs = new Map<string, BlockDefinition>();
const tintedLeaves = new Set([
  "oak_leaves", "spruce_leaves", "birch_leaves", "jungle_leaves",
  "acacia_leaves", "dark_oak_leaves", "mangrove_leaves",
]);

for (const def of [...SIMPLE_PALETTE, ...ADVANCED_PALETTE]) {
  if (!defs.has(def.id)) defs.set(def.id, def);
}

export function getBlockDefinition(id: string): BlockDefinition | undefined {
  return defs.get(id);
}

export function isKnownBlockId(id: string): boolean {
  return defs.has(id);
}

export function getRenderKind(id: string): BlockDefinition["render"] {
  return defs.get(id)?.render;
}

export function hasLeafTint(id: string): boolean {
  return tintedLeaves.has(id);
}
