export function extractFirstJsonObject(text: string): unknown | null {
  for (const slice of topLevelJsonObjectSlices(text)) {
    try {
      return JSON.parse(slice);
    } catch {
      // keep scanning, models sometimes include multiple objects or a malformed one before the real payload
    }
  }
  return null;
}

function topLevelJsonObjectSlices(text: string): string[] {
  const slices: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        slices.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return slices;
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
  for (const slice of topLevelJsonObjectSlices(text)) {
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
