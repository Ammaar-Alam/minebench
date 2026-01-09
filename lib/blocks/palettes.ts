import palettesRaw from "@/lib/blocks/palettes.json";

export type RenderKind = "opaque" | "transparent" | "cutout" | "emissive";

export type BlockDefinition = {
  id: string;
  name: string;
  category: string;
  render?: RenderKind;
};

const palettes = palettesRaw as unknown as {
  simple: BlockDefinition[];
  advanced: BlockDefinition[];
};

export const SIMPLE_PALETTE: BlockDefinition[] = palettes.simple;
export const ADVANCED_PALETTE: BlockDefinition[] = [
  ...palettes.simple,
  ...palettes.advanced,
];

export function getPalette(palette: "simple" | "advanced"): BlockDefinition[] {
  return palette === "simple" ? SIMPLE_PALETTE : ADVANCED_PALETTE;
}
