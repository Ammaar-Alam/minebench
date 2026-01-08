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

