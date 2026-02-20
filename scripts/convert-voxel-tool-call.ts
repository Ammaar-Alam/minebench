#!/usr/bin/env npx tsx
/**
 * Convert raw OpenAI/Anthropic tool-call payloads into MineBench voxel build JSON.
 *
 * Supported input shapes include:
 * - Direct tool envelope: { tool: "voxel.exec", input: { ... } }
 * - OpenAI Chat tool call: { function: { name, arguments } } / { name, arguments }
 * - OpenAI Responses function_call blocks
 * - Anthropic tool_use blocks
 * - Any wrapper object that contains one of the above shapes
 *
 * Usage:
 *   pnpm tool:convert --in model-raw-output-example.json
 *   pnpm tool:convert --in openai-response.json --out uploads/castle/castle-gpt-5-2.json
 *   cat anthropic-response.json | pnpm tool:convert --out /tmp/build.json
 *   pnpm tool:convert --in raw.json --expanded
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import "dotenv/config";
import { maxBlocksForGrid } from "../lib/ai/generateVoxelBuild";
import { extractFirstJsonObject } from "../lib/ai/jsonExtract";
import {
  runVoxelExec,
  VOXEL_EXEC_TOOL_NAME,
  voxelExecToolCallSchema,
} from "../lib/ai/tools/voxelExec";
import { getPalette } from "../lib/blocks/palettes";
import { parseVoxelBuildSpec, validateVoxelBuild } from "../lib/voxel/validate";

type GridSize = 64 | 256 | 512;
type PaletteName = "simple" | "advanced";

type Args = {
  help: boolean;
  inPath: string | null;
  paste: boolean;
  outPath: string | null;
  expanded: boolean;
  print: boolean;
  gridSizeOverride: GridSize | null;
  paletteOverride: PaletteName | null;
  seedOverride: number | null;
};

type ExtractedToolCall = {
  envelope: unknown;
  sourcePath: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const valueAfter = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? (argv[idx + 1] ?? null) : null;
  };

  const gridSizeRaw = valueAfter("--gridSize");
  let gridSizeOverride: GridSize | null = null;
  if (gridSizeRaw !== null) {
    const n = Number(gridSizeRaw);
    if (n !== 64 && n !== 256 && n !== 512) {
      throw new Error(`Invalid --gridSize value "${gridSizeRaw}". Expected 64 | 256 | 512.`);
    }
    gridSizeOverride = n;
  }

  const paletteRaw = valueAfter("--palette");
  let paletteOverride: PaletteName | null = null;
  if (paletteRaw !== null) {
    const normalized = paletteRaw.trim().toLowerCase();
    if (normalized !== "simple" && normalized !== "advanced") {
      throw new Error(`Invalid --palette value "${paletteRaw}". Expected simple | advanced.`);
    }
    paletteOverride = normalized;
  }

  const seedRaw = valueAfter("--seed");
  let seedOverride: number | null = null;
  if (seedRaw !== null) {
    const n = Number(seedRaw);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid --seed value "${seedRaw}". Expected an integer.`);
    }
    seedOverride = Math.trunc(n);
  }

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    inPath: valueAfter("--in"),
    paste: argv.includes("--paste"),
    outPath: valueAfter("--out"),
    expanded: argv.includes("--expanded"),
    print: argv.includes("--print"),
    gridSizeOverride,
    paletteOverride,
    seedOverride,
  };
}

function printHelp() {
  console.log(`
Convert tool-call JSON into MineBench build JSON

Usage:
  pnpm tool:convert --in <path>
  cat <payload.json> | pnpm tool:convert
  pnpm tool:convert --in <path> --out <build.json>

Options:
  --in <path>          Input file path. If omitted, reads from stdin.
  --paste              Read input JSON from system clipboard.
  --out <path>         Output build JSON path.
  --expanded           Write expanded/validated build (blocks-only canonical output).
  --gridSize <n>       Override grid size in call: 64 | 256 | 512.
  --palette <name>     Override palette in call: simple | advanced.
  --seed <int>         Override seed in call.
  --print              Also print resulting JSON to stdout.
  --help, -h           Show help.

Notes:
  - Input may be a full provider response object (OpenAI/Anthropic), not just the tool envelope.
  - Raw function args JSON is also accepted: { code, gridSize, palette, seed? }.
  - Output defaults to:
      <input-basename>.build.json        (or .expanded.build.json with --expanded)
    If reading from stdin or --paste:
      ./voxel-build.json                 (or ./voxel-build-expanded.json)
`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIntegerLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function maybeParseJsonString(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return extractFirstJsonObject(trimmed);
  }
}

function parsePayloadText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Input payload is empty.");

  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractFirstJsonObject(trimmed);
    if (extracted) return extracted;
    throw new Error("Input is not valid JSON and no JSON object could be extracted.");
  }
}

function toToolEnvelope(name: unknown, payload: unknown): unknown | null {
  if (typeof name !== "string" || name !== VOXEL_EXEC_TOOL_NAME) return null;

  let normalizedPayload = payload;
  if (typeof normalizedPayload === "string") {
    const parsed = maybeParseJsonString(normalizedPayload);
    if (parsed === null) return null;
    normalizedPayload = parsed;
  }

  if (isRecord(normalizedPayload)) {
    const maybeWrappedTool = normalizedPayload.tool;
    if (maybeWrappedTool === VOXEL_EXEC_TOOL_NAME && "input" in normalizedPayload) {
      return normalizedPayload;
    }
  }

  return {
    tool: VOXEL_EXEC_TOOL_NAME,
    input: normalizedPayload,
  };
}

function tryExtractToolCallFromNode(node: unknown): unknown | null {
  if (!isRecord(node)) return null;

  // Raw function args only: { code, gridSize, palette, seed? }
  if (
    typeof node.code === "string" &&
    "gridSize" in node &&
    "palette" in node
  ) {
    return {
      tool: VOXEL_EXEC_TOOL_NAME,
      input: node,
    };
  }

  // Direct envelope: { tool: "voxel.exec", input: {...} }
  if (node.tool === VOXEL_EXEC_TOOL_NAME && "input" in node) {
    return {
      tool: VOXEL_EXEC_TOOL_NAME,
      input: node.input,
    };
  }

  // Common provider shapes:
  // { name: "voxel.exec", arguments: "{...}" }
  // { type: "tool_use", name: "voxel.exec", input: {...} }
  // { function: { name: "voxel.exec", arguments: "{...}" } }
  const fromNameWithInput = toToolEnvelope(
    node.name,
    node.input ?? node.arguments ?? node.parameters,
  );
  if (fromNameWithInput) return fromNameWithInput;

  if (isRecord(node.function)) {
    const fn = node.function;
    const fromFunctionObject = toToolEnvelope(
      fn.name,
      fn.input ?? fn.arguments ?? fn.parameters,
    );
    if (fromFunctionObject) return fromFunctionObject;
  }

  return null;
}

function extractToolCall(root: unknown): ExtractedToolCall | null {
  const queue: Array<{ value: unknown; path: string }> = [{ value: root, path: "$" }];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const direct = tryExtractToolCallFromNode(current.value);
    if (direct) return { envelope: direct, sourcePath: current.path };

    if (Array.isArray(current.value)) {
      for (let i = 0; i < current.value.length; i += 1) {
        queue.push({ value: current.value[i], path: `${current.path}[${i}]` });
      }
      continue;
    }

    if (isRecord(current.value)) {
      if (seen.has(current.value)) continue;
      seen.add(current.value);
      for (const [key, value] of Object.entries(current.value)) {
        queue.push({ value, path: `${current.path}.${key}` });
      }
      continue;
    }

    // Some APIs put tool call JSON in a string field.
    if (typeof current.value === "string") {
      const parsed = maybeParseJsonString(current.value);
      if (parsed !== null) {
        queue.push({ value: parsed, path: `${current.path}<json>` });
      }
    }
  }

  return null;
}

function normalizeEnvelope(
  rawEnvelope: unknown,
  overrides: Pick<Args, "gridSizeOverride" | "paletteOverride" | "seedOverride">,
): unknown {
  if (!isRecord(rawEnvelope)) return rawEnvelope;

  const tool = rawEnvelope.tool;
  const rawInput = rawEnvelope.input;

  const normalizedInput: Record<string, unknown> = isRecord(rawInput)
    ? { ...rawInput }
    : {};

  const gridSize = parseIntegerLike(normalizedInput.gridSize);
  if (gridSize !== null) normalizedInput.gridSize = gridSize;

  if (typeof normalizedInput.palette === "string") {
    normalizedInput.palette = normalizedInput.palette.trim().toLowerCase();
  }

  if (normalizedInput.seed === null || normalizedInput.seed === "") {
    delete normalizedInput.seed;
  } else {
    const seed = parseIntegerLike(normalizedInput.seed);
    if (seed !== null) normalizedInput.seed = seed;
  }

  if (overrides.gridSizeOverride !== null) normalizedInput.gridSize = overrides.gridSizeOverride;
  if (overrides.paletteOverride !== null) normalizedInput.palette = overrides.paletteOverride;
  if (overrides.seedOverride !== null) normalizedInput.seed = overrides.seedOverride;

  return {
    tool: typeof tool === "string" ? tool : VOXEL_EXEC_TOOL_NAME,
    input: normalizedInput,
  };
}

function ensureParentDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readClipboardText(): string {
  type ClipCmd = { label: string; cmd: string; args: string[] };
  const commands: ClipCmd[] =
    process.platform === "darwin"
      ? [{ label: "pbpaste", cmd: "pbpaste", args: [] }]
      : process.platform === "win32"
        ? [
            {
              label: "powershell Get-Clipboard",
              cmd: "powershell",
              args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
            },
          ]
        : [
            { label: "wl-paste", cmd: "wl-paste", args: ["--no-newline"] },
            { label: "xclip", cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
            { label: "xsel", cmd: "xsel", args: ["--clipboard", "--output"] },
          ];

  const errors: string[] = [];
  for (const entry of commands) {
    const res = spawnSync(entry.cmd, entry.args, { encoding: "utf-8" });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        errors.push(`${entry.label}: command not found`);
        continue;
      }
      errors.push(`${entry.label}: ${err.message}`);
      continue;
    }
    if (res.status !== 0) {
      const stderr = (res.stderr ?? "").trim();
      errors.push(`${entry.label}: exit ${res.status}${stderr ? ` (${stderr})` : ""}`);
      continue;
    }

    const out = (res.stdout ?? "").toString();
    if (!out.trim()) {
      throw new Error("Clipboard is empty (or only whitespace).");
    }
    return out;
  }

  throw new Error(
    `Failed to read clipboard text. Tried: ${errors.join("; ")}`,
  );
}

async function readInputPayload(inPath: string | null, paste: boolean): Promise<{ sourceLabel: string; payload: unknown }> {
  if (inPath && paste) {
    throw new Error("Use either --in <path> or --paste, not both.");
  }

  if (inPath) {
    const abs = path.resolve(inPath);
    if (!fs.existsSync(abs)) throw new Error(`Input file not found: ${abs}`);
    const raw = fs.readFileSync(abs, "utf-8");
    return {
      sourceLabel: path.relative(process.cwd(), abs),
      payload: parsePayloadText(raw),
    };
  }

  if (paste) {
    const raw = readClipboardText();
    return { sourceLabel: "clipboard", payload: parsePayloadText(raw) };
  }

  if (process.stdin.isTTY) {
    throw new Error("No input provided. Pass --in <path>, use --paste, or pipe JSON via stdin.");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return { sourceLabel: "stdin", payload: parsePayloadText(raw) };
}

function defaultOutputPath(inPath: string | null, expanded: boolean): string {
  if (inPath) {
    const abs = path.resolve(inPath);
    const ext = path.extname(abs);
    const base = ext ? abs.slice(0, -ext.length) : abs;
    return `${base}${expanded ? ".expanded" : ""}.build.json`;
  }
  return path.resolve(process.cwd(), expanded ? "voxel-build-expanded.json" : "voxel-build.json");
}

function supportsTerminalHyperlinks(): boolean {
  if (!process.stdout.isTTY) return false;
  if ((process.env.TERM ?? "").toLowerCase() === "dumb") return false;
  if (process.env.CI) return false;
  return true;
}

function formatFileLink(filePath: string): { displayPath: string; absoluteUrl: string } {
  const displayPath = path.relative(process.cwd(), filePath);
  const absoluteUrl = pathToFileURL(path.resolve(filePath)).toString();
  if (!supportsTerminalHyperlinks()) return { displayPath, absoluteUrl };
  const hyperlink = `\u001B]8;;${absoluteUrl}\u0007${displayPath}\u001B]8;;\u0007`;
  return { displayPath: hyperlink, absoluteUrl };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  const { sourceLabel, payload } = await readInputPayload(args.inPath, args.paste);
  const extracted = extractToolCall(payload);
  if (!extracted) {
    throw new Error(
      `Could not find a "${VOXEL_EXEC_TOOL_NAME}" tool call in input payload.`,
    );
  }

  const normalizedEnvelope = normalizeEnvelope(extracted.envelope, {
    gridSizeOverride: args.gridSizeOverride,
    paletteOverride: args.paletteOverride,
    seedOverride: args.seedOverride,
  });

  const parsedCall = voxelExecToolCallSchema.safeParse(normalizedEnvelope);
  if (!parsedCall.success) {
    throw new Error(`Invalid tool call payload: ${parsedCall.error.message}`);
  }
  const call = parsedCall.data;

  const run = runVoxelExec({
    code: call.input.code,
    gridSize: call.input.gridSize,
    palette: call.input.palette,
    seed: call.input.seed,
  });

  const parsedSpec = parseVoxelBuildSpec(run.build);
  if (!parsedSpec.ok) {
    throw new Error(`Generated build spec is invalid: ${parsedSpec.error}`);
  }

  const paletteDefs = getPalette(call.input.palette);
  const validated = validateVoxelBuild(parsedSpec.value, {
    gridSize: call.input.gridSize,
    palette: paletteDefs,
    maxBlocks: maxBlocksForGrid(call.input.gridSize),
  });
  if (!validated.ok) {
    throw new Error(`Generated build failed validation: ${validated.error}`);
  }

  const outputBuild = args.expanded ? validated.value.build : parsedSpec.value;
  const outPath = path.resolve(args.outPath ?? defaultOutputPath(args.inPath, args.expanded));
  ensureParentDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(outputBuild, null, 2)}\n`);

  const fileLink = formatFileLink(outPath);
  console.log("🔧 MineBench tool-call conversion");
  console.log(`Source: ${sourceLabel}`);
  console.log(`Match path: ${extracted.sourcePath}`);
  console.log(
    `Call: gridSize=${call.input.gridSize}, palette=${call.input.palette}, seed=${
      typeof call.input.seed === "number" ? call.input.seed : "<none>"
    }`,
  );
  console.log(
    `Runtime primitives: blocks=${run.blockCount}, boxes=${run.boxCount}, lines=${run.lineCount}`,
  );
  console.log(`Validated expanded blocks: ${validated.value.build.blocks.length}`);
  if (validated.value.warnings.length > 0) {
    console.log(`Validation warnings: ${validated.value.warnings.length}`);
    for (const warning of validated.value.warnings.slice(0, 3)) {
      console.log(`  - ${warning}`);
    }
    if (validated.value.warnings.length > 3) {
      console.log(`  - ...and ${validated.value.warnings.length - 3} more`);
    }
  }
  console.log(`✅ Wrote ${fileLink.displayPath}`);
  console.log(`   ${fileLink.absoluteUrl}`);

  if (args.print) {
    process.stdout.write(`${JSON.stringify(outputBuild, null, 2)}\n`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exitCode = 1;
});
