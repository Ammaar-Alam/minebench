export function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;

    if (depth === 0) {
      const slice = text.slice(start, i + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function voxelBlocksLength(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { version?: unknown; blocks?: unknown };
  if (v.version !== "1.0") return null;
  if (!Array.isArray(v.blocks)) return null;
  return v.blocks.length;
}

export function extractBestVoxelBuildJson(text: string): unknown | null {
  const candidates: { value: unknown; blocksLen: number }[] = [];

  // Scan for multiple JSON objects and pick the one that most looks like a VoxelBuild.
  // This prevents accidentally extracting a small example object if the model outputs more than one JSON object.
  const maxCandidates = 32;
  let searchFrom = 0;

  while (candidates.length < maxCandidates) {
    const start = text.indexOf("{", searchFrom);
    if (start < 0) break;

    let depth = 0;
    let foundEnd = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;

      if (depth === 0) {
        foundEnd = i;
        break;
      }
    }

    if (foundEnd < 0) break;
    searchFrom = foundEnd + 1;

    const slice = text.slice(start, foundEnd + 1);
    try {
      const parsed = JSON.parse(slice) as unknown;
      const len = voxelBlocksLength(parsed);
      if (typeof len === "number") candidates.push({ value: parsed, blocksLen: len });
    } catch {
      // ignore
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.blocksLen - a.blocksLen);
    return candidates[0].value;
  }

  return extractFirstJsonObject(text);
}
