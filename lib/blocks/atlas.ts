import atlas from "@/lib/blocks/atlas-map.json";

export type AtlasMap = typeof atlas;
export type AtlasKey = keyof AtlasMap["keys"];

export const ATLAS = atlas;

export function hasAtlasKey(key: string): key is AtlasKey {
  return Object.prototype.hasOwnProperty.call(ATLAS.keys, key);
}

export function getAtlasUv(key: AtlasKey) {
  return ATLAS.keys[key];
}

