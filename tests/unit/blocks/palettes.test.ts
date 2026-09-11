import assert from "node:assert/strict";
import palettesRaw from "../../../lib/blocks/palettes.json";
import { hasAtlasKey } from "../../../lib/blocks/atlas";
import { getRenderKind } from "../../../lib/blocks/registry";
import { getTextureKey, type Face } from "../../../lib/blocks/textures";
import { getPalette } from "../../../lib/blocks/palettes";
import { getMinecraftBlockState } from "../../../lib/voxel/export/blockStates";

const standardColors = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
] as const;

const legacySimpleIds = [
  "stone",
  "cobblestone",
  "oak_planks",
  "bricks",
  "stone_bricks",
  "grass_block",
  "dirt",
  "sand",
  "oak_log",
  "oak_leaves",
  "water",
  "white_wool",
  "black_wool",
  "red_wool",
  "blue_wool",
  "green_wool",
  "yellow_wool",
  "orange_wool",
  "purple_wool",
  "brown_wool",
  "gray_wool",
  "glass",
  "glowstone",
  "iron_block",
  "gold_block",
] as const;

const legacyAdvancedIds = [
  "stone_bricks",
  "mossy_stone_bricks",
  "cracked_stone_bricks",
  "granite",
  "diorite",
  "andesite",
  "deepslate",
  "spruce_planks",
  "birch_planks",
  "dark_oak_planks",
  "spruce_log",
  "birch_log",
  "quartz_block",
  "smooth_stone",
  "sandstone",
  "red_sandstone",
  "nether_bricks",
  "prismarine",
  "terracotta",
  "white_concrete",
  "gravel",
  "clay",
  "snow",
  "ice",
  "packed_ice",
  "moss_block",
  "flowering_azalea_leaves",
  "lava",
  "soul_sand",
  "netherrack",
  "gray_wool",
  "light_gray_wool",
  "cyan_wool",
  "light_blue_wool",
  "lime_wool",
  "magenta_wool",
  "pink_wool",
  "brown_wool",
  "red_concrete",
  "blue_concrete",
  "green_concrete",
  "yellow_concrete",
  "black_concrete",
  "copper_block",
  "oxidized_copper",
  "obsidian",
  "crying_obsidian",
  "sea_lantern",
  "redstone_block",
  "emerald_block",
  "diamond_block",
  "lapis_block",
  "tinted_glass",
  "amethyst_block",
  "ancient_debris",
] as const;

const faces: Face[] = ["north", "south", "east", "west", "up", "down"];

function idsFor(suffix: string) {
  return standardColors.map((color) => `${color}_${suffix}`);
}

function assertIncluded(ids: string[], expected: string[]) {
  for (const id of expected) assert.ok(ids.includes(id), `missing ${id}`);
}

const simpleIds = palettesRaw.simple.map((block) => block.id);
const advancedExtraIds = palettesRaw.advanced.map((block) => block.id);
const advancedIds = getPalette("advanced").map((block) => block.id);

assert.deepEqual(simpleIds, [...legacySimpleIds]);
assert.deepEqual(advancedExtraIds.slice(0, legacyAdvancedIds.length), [...legacyAdvancedIds]);
assert.equal(simpleIds.length, 25);
assert.equal(advancedExtraIds.length, 217);
assert.equal(advancedIds.length, 242);
assert.ok(advancedIds.length <= 255);

assertIncluded(advancedIds, idsFor("wool"));
assertIncluded(advancedIds, idsFor("concrete"));
assertIncluded(advancedIds, ["terracotta", ...idsFor("terracotta")]);
assertIncluded(advancedIds, ["glass", "tinted_glass", ...idsFor("stained_glass")]);

for (const id of idsFor("stained_glass")) {
  assert.equal(getRenderKind(id), "transparent", `${id} should render as transparent`);
}

for (const id of [
  "oak_leaves",
  "flowering_azalea_leaves",
  "spruce_leaves",
  "birch_leaves",
  "jungle_leaves",
  "acacia_leaves",
  "dark_oak_leaves",
  "mangrove_leaves",
  "cherry_leaves",
  "pale_oak_leaves",
]) {
  assert.equal(getRenderKind(id), "cutout", `${id} should render as cutout`);
  assert.equal(getMinecraftBlockState(id), `minecraft:${id}[persistent=true]`);
}

for (const id of ["glowstone", "lava", "sea_lantern", "shroomlight"]) {
  assert.equal(getRenderKind(id), "emissive", `${id} should render as emissive`);
}

const faceExpectations: Array<[string, Face, string]> = [
  ["bookshelf", "up", "oak_planks"],
  ["bookshelf", "down", "oak_planks"],
  ["podzol", "down", "dirt"],
  ["mycelium", "down", "dirt"],
  ["cut_sandstone", "up", "sandstone_top"],
  ["cut_sandstone", "down", "sandstone_bottom"],
  ["chiseled_sandstone", "up", "sandstone_top"],
  ["chiseled_sandstone", "down", "sandstone_bottom"],
  ["cut_red_sandstone", "up", "red_sandstone_top"],
  ["cut_red_sandstone", "down", "red_sandstone_bottom"],
  ["chiseled_red_sandstone", "up", "red_sandstone_top"],
  ["chiseled_red_sandstone", "down", "red_sandstone_bottom"],
];

for (const [id, face, key] of faceExpectations) {
  assert.equal(getTextureKey(id, face), key);
}

for (const block of getPalette("advanced")) {
  for (const face of faces) {
    const key = getTextureKey(block.id, face);
    assert.ok(hasAtlasKey(key), `${block.id} ${face} resolved to missing atlas key ${key}`);
  }
}

console.log("palette coverage checks passed");
