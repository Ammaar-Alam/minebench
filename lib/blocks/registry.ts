import { ADVANCED_PALETTE, BlockDefinition, SIMPLE_PALETTE } from "@/lib/blocks/palettes";

const defs = new Map<string, BlockDefinition>();

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

