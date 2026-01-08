import { hasAtlasKey } from "@/lib/blocks/atlas";

export type Face = "north" | "south" | "east" | "west" | "up" | "down";

const ALIASES: Record<string, string> = {
  water: "water_still",
  lava: "lava_still"
};

function canonicalBlockId(blockId: string) {
  return ALIASES[blockId] ?? blockId;
}

function pick(candidates: string[]) {
  for (const c of candidates) if (hasAtlasKey(c)) return c;
  return candidates[0]!;
}

export function getTextureKey(blockId: string, face: Face): string {
  if (blockId === "grass_block") {
    if (face === "up") return "grass_block_top";
    if (face === "down") return "dirt";
    return "grass_block_side";
  }

  const base = canonicalBlockId(blockId);
  if (face === "up") return pick([`${base}_top`, `${base}_side`, base]);
  if (face === "down") return pick([`${base}_bottom`, `${base}_top`, `${base}_side`, base]);
  return pick([`${base}_side`, base, `${base}_top`]);
}

