import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const repoRoot = process.cwd();
const srcDir = path.join(repoRoot, "assets", "texture-pack", "assets", "minecraft", "textures", "block");

const palettesPath = path.join(repoRoot, "lib", "blocks", "palettes.json");
const publicOutDir = path.join(repoRoot, "public", "textures");
const outPng = path.join(publicOutDir, "atlas.png");
const outMapLib = path.join(repoRoot, "lib", "blocks", "atlas-map.json");

const TILE_SIZE = 32;

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

async function main() {
  const palettesRaw = await fs.readFile(palettesPath, "utf8");
  const palettes = JSON.parse(palettesRaw);

  const blockIds = [
    ...palettes.simple.map((b) => b.id),
    ...palettes.advanced.map((b) => b.id)
  ];

  const files = new Set(await fs.readdir(srcDir));
  const keys = new Set();
  for (const id of blockIds) {
    for (const key of keysForBlockId(id, files)) keys.add(key);
  }

  const keyList = Array.from(keys).sort();
  if (keyList.length === 0) throw new Error("No textures selected");

  for (const key of keyList) {
    if (!files.has(`${key}.png`)) {
      throw new Error(`Missing texture file: ${key}.png`);
    }
  }

  const PADDING = 8;
  const PADDED_TILE_SIZE = TILE_SIZE + PADDING * 2;
  const cols = Math.ceil(Math.sqrt(keyList.length));
  const rows = Math.ceil(keyList.length / cols);
  const atlasWidth = cols * PADDED_TILE_SIZE;
  const atlasHeight = rows * PADDED_TILE_SIZE;

  await fs.mkdir(publicOutDir, { recursive: true });
  await fs.mkdir(path.dirname(outMapLib), { recursive: true });

  const composites = await Promise.all(
    keyList.map(async (key, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);

      const file = path.join(srcDir, `${key}.png`);
      const base = sharp(file);
      const meta = await base.metadata();
      let pipeline = base.ensureAlpha();

      // Handle animated textures (e.g. 32x1024 water/lava strips): take the first frame.
      if (
        typeof meta.width === "number" &&
        typeof meta.height === "number" &&
        (meta.width !== TILE_SIZE || meta.height !== TILE_SIZE)
      ) {
        pipeline = pipeline.extract({
          left: 0,
          top: 0,
          width: Math.min(TILE_SIZE, meta.width),
          height: Math.min(TILE_SIZE, meta.height)
        });
      }

      const input = await pipeline
        .resize(TILE_SIZE, TILE_SIZE, {
          fit: "fill",
          kernel: sharp.kernel.nearest
        })
        .extend({
          top: PADDING,
          bottom: PADDING,
          left: PADDING,
          right: PADDING,
          extendWith: "copy"
        })
        .png()
        .toBuffer();

      return {
        input,
        left: col * PADDED_TILE_SIZE,
        top: row * PADDED_TILE_SIZE
      };
    })
  );

  const atlas = sharp({
    create: {
      width: atlasWidth,
      height: atlasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).composite(composites);

  await atlas.png().toFile(outPng);

  const keyToUv = {};
  for (const [index, key] of keyList.entries()) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * PADDED_TILE_SIZE + PADDING;
    const y = row * PADDED_TILE_SIZE + PADDING;
    const bottomY = atlasHeight - y - TILE_SIZE;

    keyToUv[key] = {
      x,
      y,
      w: TILE_SIZE,
      h: TILE_SIZE,
      u0: x / atlasWidth,
      u1: (x + TILE_SIZE) / atlasWidth,
      v0: bottomY / atlasHeight,
      v1: (bottomY + TILE_SIZE) / atlasHeight
    };
  }

  const out = {
    tileSize: TILE_SIZE,
    atlasWidth,
    atlasHeight,
    keys: keyToUv
  };

  await fs.writeFile(outMapLib, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log(
    `atlas: ${keyList.length} tiles → ${path.relative(repoRoot, outPng)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
