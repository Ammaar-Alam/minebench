import { hasAtlasKey } from "@/lib/blocks/atlas";

export type Face = "north" | "south" | "east" | "west" | "up" | "down";

const ALIASES: Record<string, string> = {
  water: "water_still",
  lava: "lava_still",
  magma_block: "magma",
  dried_kelp_block: "dried_kelp",
  smooth_quartz: "quartz_block_bottom",
  smooth_sandstone: "sandstone_top",
  smooth_red_sandstone: "red_sandstone_top"
};

const FACE_TEXTURES: Record<string, Partial<Record<Face, string>>> = {
  bookshelf: { up: "oak_planks", down: "oak_planks" },
  podzol: { down: "dirt" },
  mycelium: { down: "dirt" },
  crimson_nylium: { up: "crimson_nylium", down: "netherrack" },
  warped_nylium: { up: "warped_nylium", down: "netherrack" },
  cut_sandstone: { up: "sandstone_top", down: "sandstone_bottom" },
  chiseled_sandstone: { up: "sandstone_top", down: "sandstone_bottom" },
  cut_red_sandstone: { up: "red_sandstone_top", down: "red_sandstone_bottom" },
  chiseled_red_sandstone: { up: "red_sandstone_top", down: "red_sandstone_bottom" }
};

function canonicalBlockId(blockId: string) {
  return ALIASES[blockId] ?? blockId;
}

function pick(candidates: string[]) {
  for (const c of candidates) if (hasAtlasKey(c)) return c;
  return candidates[0]!;
}

export function getTextureKey(blockId: string, face: Face): string {
  const faceTexture = FACE_TEXTURES[blockId]?.[face];
  if (faceTexture) return faceTexture;

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
