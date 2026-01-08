import { getPalette } from "@/lib/blocks/palettes";

export function buildSystemPrompt(opts: {
  gridSize: number;
  maxBlocks: number;
  minBlocks: number;
  palette: "simple" | "advanced";
}): string {
  const paletteBlocks = getPalette(opts.palette);
  const blockList = paletteBlocks
    .map((b) => `- ${b.id}: ${b.name}`)
    .join("\n");

  const center = Math.floor(opts.gridSize / 2);
  const targetLow = Math.max(opts.minBlocks, Math.floor(opts.minBlocks * 2));
  const targetHigh = Math.max(targetLow, Math.floor(opts.minBlocks * 6));
  const footprintTarget = Math.max(8, Math.floor(opts.gridSize * 0.6));
  const heightTarget = Math.max(4, Math.floor(opts.gridSize * 0.18));

  return [
    "You are a 3D voxel construction AI.",
    "You must produce a Minecraft-style voxel build from a natural language prompt.",
    "",
    "OUTPUT FORMAT",
    "Return ONLY valid JSON (no markdown, no explanation) matching this schema:",
    '{ "version": "1.0", "blocks": [ { "x": 0, "y": 0, "z": 0, "type": "stone" } ] }',
    "",
    "COORDINATE SYSTEM",
    `- Grid bounds: x,y,z are integers in [0, ${opts.gridSize - 1}]`,
    "- y is vertical (height). y=0 is ground level.",
    `- Prefer to center the build around x≈${center}, z≈${center}.`,
    "",
    "CONSTRUCTION GUIDELINES",
    "- Match the prompt literally and prioritize recognizability over tiny or generic builds, use this as an opportunity to show your creativity.",
    "- If the prompt includes specific features (e.g., 'with sails'), include them clearly.",
    "- Use appropriate materials (e.g., planks/logs for wood structures; wool for cloth/sails; stone for foundations; water for sea).",
    "- Keep the build reasonably sized so it fits in the grid and is fast to render.",
    `- Build size: aim for ~${targetLow}–${targetHigh} blocks (minimum ~${opts.minBlocks}). Make it detailed and recognizable.`,
    `- Scale: aim for a large footprint. Use about ${footprintTarget}+ blocks of span across x or z (not just a tiny centered clump).`,
    `- Add vertical structure when appropriate. Use about ${heightTarget}+ blocks of height span for tall prompts (masts, towers, trees).`,
    "- Avoid filler-only outputs (e.g. just a flat water plane, just a square hut, or a single block).",
    "- If the prompt is a vehicle/thing with distinctive parts (ship: hull + deck + mast(s) + sail(s); house: walls + roof + door/windows), include those parts.",
    "",
    "CONSTRAINTS",
    `- Do not exceed ${opts.maxBlocks} total blocks.`,
    "- Every block type must be from the available block list below.",
    "- Use the block IDs EXACTLY as listed. Unknown IDs will be dropped.",
    "",
    "AVAILABLE BLOCKS",
    blockList,
  ].join("\n");
}

export function buildUserPrompt(prompt: string): string {
  return `Build the following: ${prompt}\n\nRemember: output ONLY the JSON object.`;
}

export function buildRepairPrompt(params: {
  error: string;
  previousOutput: string;
}): string {
  return [
    "Your previous output was invalid.",
    `Reason: ${params.error}`,
    "",
    "Fix it by returning ONLY a corrected JSON object that matches the required schema and constraints.",
    "",
    "Previous output:",
    params.previousOutput,
  ].join("\n");
}
