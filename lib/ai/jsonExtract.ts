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

    // At depth 0 a `"` opens a prose-quote span. If the closing `"` appears
    // before the next top-level `{`, the span is balanced prose (e.g.
    // `The JSON starts with "{"`). Skip the entire span so that any braces
    // inside it are not mistaken for object boundaries.
    // If the closing `"` is absent or comes only after a `{`, the quote is a
    // stray prose quote; skip just the quote character and scan on normally,
    // preserving the original behaviour for unbalanced quotes.
    if (depth === 0 && ch === '"') {
      // Lookahead: find closing quote and next brace.
      const closeIdx = text.indexOf('"', i + 1);
      const braceIdx = text.indexOf('{', i + 1);
      if (closeIdx !== -1 && (braceIdx === -1 || closeIdx < braceIdx)) {
        // Balanced prose-quote span — skip past the closing quote.
        i = closeIdx;
      }
      // Whether balanced or stray, consume the opening quote and continue.
      continue;
    }

    // Only treat " as a JSON string delimiter once we are inside an object.
    if (depth > 0 && ch === '"') {
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
