import { appendCoalescedVoxelBox, appendPackedVoxelBlocks, createPackedVoxelBlocks } from "@/lib/voxel/packedBlocks";
import type { VoxelBuild } from "@/lib/voxel/types";
import { parseOwnedVoxelBuildSpec } from "@/lib/voxel/validate";

// read one primitive at a time so source files never become a single JS string
export async function parseVoxelBuildStream(chunks: AsyncIterable<Uint8Array>): Promise<VoxelBuild> {
  const build: VoxelBuild = { version: "1.0", boxes: [], lines: [], blocks: [], packed: createPackedVoxelBlocks(0) };
  const batch: unknown[] = [];
  const fields = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let cursor = 0;
  let state: "root" | "key" | "colon" | "value" | "ignored-value" | "item" | "separator" | "field-separator" | "done" = "root";
  let field = "";
  let tokenStart = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let afterComma = false;
  let primitive = false;

  const flush = () => {
    if (!batch.length) return;
    const candidate = {
      version: "1.0",
      blocks: field === "blocks" ? batch : [],
      ...(field === "boxes" ? { boxes: batch } : {}),
      ...(field === "lines" ? { lines: batch } : {}),
    };
    const parsed = parseOwnedVoxelBuildSpec(candidate);
    if (!parsed.ok) throw new Error(`Invalid ${field} entry: ${parsed.error}`);
    if (field === "boxes") {
      for (const { x1, y1, z1, x2, y2, z2, type } of parsed.value.boxes!) {
        appendCoalescedVoxelBox(build.boxes!, { x1, y1, z1, x2, y2, z2, type });
      }
    } else if (field === "lines") {
      for (const { from, to, type } of parsed.value.lines!) {
        build.lines!.push({
          from: { x: from.x, y: from.y, z: from.z },
          to: { x: to.x, y: to.y, z: to.z },
          type,
        });
      }
    } else {
      for (const block of parsed.value.blocks) {
        if (block.x < -32768 || block.x > 32767 || block.y < -32768 || block.y > 32767 || block.z < -32768 || block.z > 32767) {
          throw new Error("Block coordinate is outside the supported integer range");
        }
      }
      appendPackedVoxelBlocks(build.packed!, parsed.value.blocks);
    }
    batch.length = 0;
  };

  const scan = () => {
    while (cursor < buffer.length) {
      const ch = buffer[cursor]!;
      if (tokenStart >= 0) {
        const primitiveEnded = primitive && (ch === "," || ch === "}" || " \t\r\n".includes(ch));
        if (!primitiveEnded) {
          if (quoted) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') quoted = false;
          } else if (ch === '"') quoted = true;
          else if (ch === "{" || ch === "[") depth += 1;
          else if (ch === "}" || ch === "]") depth -= 1;
          cursor += 1;
        }
        if (cursor - tokenStart > 1_000_000) throw new Error("Build entry is too large");
        if (!primitiveEnded && (primitive || quoted || depth > 0)) continue;
        const value: unknown = JSON.parse(buffer.slice(tokenStart, cursor));
        tokenStart = -1;
        primitive = false;
        if (state === "key") {
          if (typeof value !== "string") throw new Error("Expected a build field");
          if (fields.has(value)) throw new Error(`Duplicate build field: ${value}`);
          fields.add(value);
          field = value;
          state = "colon";
        } else if (state === "value") {
          if (value !== "1.0") throw new Error("Unsupported build version");
          state = "field-separator";
        } else if (state === "ignored-value") {
          state = "field-separator";
        } else {
          batch.push(value);
          if (batch.length >= 4096) flush();
          state = "separator";
        }
        continue;
      }
      if (" \t\r\n".includes(ch)) { cursor += 1; continue; }
      if (state === "root") {
        if (ch !== "{") throw new Error("Expected a build JSON object");
        state = "key";
      } else if (state === "key") {
        if (ch === "}" && !afterComma) state = "done";
        else if (ch === '"') {
          tokenStart = cursor;
          quoted = true;
          depth = 0;
        } else throw new Error("Expected a build field name");
      } else if (state === "colon") {
        if (ch !== ":") throw new Error("Expected a colon after the build field");
        state = "value";
      } else if (state === "value") {
        if (!["version", "boxes", "lines", "blocks"].includes(field)) {
          state = "ignored-value";
          tokenStart = cursor;
          quoted = ch === '"';
          depth = ch === "{" || ch === "[" ? 1 : 0;
          primitive = !quoted && depth === 0;
        } else if (field === "version" && ch === '"') {
          tokenStart = cursor;
          quoted = true;
          depth = 0;
        } else if (field !== "version" && ch === "[") {
          state = "item";
          afterComma = false;
        } else throw new Error("Invalid build field value");
      } else if (state === "item") {
        if (ch === "]" && !afterComma) state = "field-separator";
        else if (ch === "{") {
          tokenStart = cursor;
          depth = 1;
          quoted = false;
        } else throw new Error(`Expected an object in ${field}`);
      } else if (state === "separator") {
        if (ch === "]") { flush(); state = "field-separator"; }
        else if (ch === ",") { state = "item"; afterComma = true; }
        else throw new Error(`Expected a comma in ${field}`);
      } else if (state === "field-separator") {
        if (ch === "}") state = "done";
        else if (ch === ",") { state = "key"; afterComma = true; }
        else throw new Error("Expected a comma between build fields");
      } else throw new Error("Unexpected content after the build");
      cursor += 1;
    }
    const consumed = tokenStart >= 0 ? tokenStart : cursor;
    buffer = buffer.slice(consumed);
    cursor -= consumed;
    if (tokenStart >= 0) tokenStart = 0;
  };

  for await (const bytes of chunks) {
    buffer += decoder.decode(bytes, { stream: true });
    scan();
  }
  buffer += decoder.decode();
  scan();
  if ((state as string) !== "done" || tokenStart >= 0 || !fields.has("version") || !fields.has("blocks")) {
    throw new Error("Incomplete build JSON");
  }
  flush();
  return build;
}
