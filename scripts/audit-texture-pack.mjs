import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const srcDir = path.join(
  repoRoot,
  "faithful-32x-1.21.11",
  "assets",
  "minecraft",
  "textures",
  "block"
);

const palettesPath = path.join(repoRoot, "lib", "blocks", "palettes.json");

const ALIASES = {
  water: "water_still",
  lava: "lava_still"
};

function canonicalBlockId(id) {
  return ALIASES[id] ?? id;
}

function keysForBlockId(blockId, files) {
  if (blockId === "grass_block") {
    return ["grass_block_top", "grass_block_side", "dirt"];
  }

  const base = canonicalBlockId(blockId);
  const candidates = [
    base,
    `${base}_side`,
    `${base}_top`,
    `${base}_bottom`
  ];

  return candidates.filter((key) => files.has(`${key}.png`));
}

function parseFlags(args) {
  const flags = new Set(args);
  return {
    list: flags.has("--list"),
    listUsed: flags.has("--list-used"),
    listUnused: flags.has("--list-unused"),
    listMcmeta: flags.has("--list-mcmeta")
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const palettesRaw = await fs.readFile(palettesPath, "utf8");
  const palettes = JSON.parse(palettesRaw);

  const blockIds = [
    ...palettes.simple.map((b) => b.id),
    ...palettes.advanced.map((b) => b.id)
  ];

  const files = new Set(await fs.readdir(srcDir));
  const allPng = Array.from(files).filter((f) => f.endsWith(".png")).sort();
  const allMcmeta = Array.from(files).filter((f) => f.endsWith(".png.mcmeta")).sort();

  const usedPng = new Set();
  for (const id of blockIds) {
    for (const key of keysForBlockId(id, files)) usedPng.add(`${key}.png`);
  }

  const used = Array.from(usedPng).sort();
  const unused = allPng.filter((f) => !usedPng.has(f));

  console.log("MineBench texture pack audit");
  console.log(`- Source dir: ${path.relative(repoRoot, srcDir)}`);
  console.log(`- Palette blocks: ${blockIds.length}`);
  console.log(`- PNGs used by atlas: ${used.length}`);
  console.log(`- PNGs unused (safe to delete for atlas builds): ${unused.length}`);
  console.log(`- .png.mcmeta files (not used by atlas build): ${allMcmeta.length}`);

  if (flags.list || flags.listUsed) {
    console.log("\nUsed PNGs:");
    for (const f of used) console.log(`- ${f}`);
  }

  if (flags.list || flags.listUnused) {
    console.log("\nUnused PNGs:");
    for (const f of unused) console.log(`- ${f}`);
  }

  if (flags.list || flags.listMcmeta) {
    console.log("\n.png.mcmeta files:");
    for (const f of allMcmeta) console.log(`- ${f}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

