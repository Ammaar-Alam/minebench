# Voxel Exec Runtime, Conversion, and Import Workflows

This document explains what `voxel.exec` is in MineBench today, what models can do with it, and the practical commands for converting, running, and importing tool-call output.

Default runtime behavior in MineBench: model generations run in `voxel.exec` tool mode. The persisted and rendered artifact is always final voxel build JSON in `version/boxes/lines/blocks` format.

## 1) What `voxel.exec` is

`voxel.exec` is the minimal code-execution tool used during generation.

- Tool name: `voxel.exec`
- Input schema:
  - `code` (string)
  - `gridSize` (`64 | 256 | 512`)
  - `palette` (`simple | advanced`)
  - `seed` (optional int)

Implementation:

- Tool schema and runtime: `lib/ai/tools/voxelExec.ts`
- Generation integration: `lib/ai/generateVoxelBuild.ts`
- Local execution API: `app/api/local/voxel-exec/route.ts`
- Conversion utility: `scripts/convert-voxel-tool-call.ts`

## 2) Primitives available to model code

Inside tool-mode code, models can use:

- `block(x, y, z, type)`
- `box(x1, y1, z1, x2, y2, z2, type)`
- `line(x1, y1, z1, x2, y2, z2, type)`
- `rng()` (seeded when seed is provided)
- `Math`
- constants: `GRID_SIZE`, `PALETTE`

That surface is intentionally minimal. The model has to do its own planning, geometry, and decomposition.

## 3) Raw tool-call shape

MineBench includes a real tool-call payload example:

- File: [`examples/voxel-exec-tool-call-example.json`](./examples/voxel-exec-tool-call-example.json)

Example shape:

```json
{
  "tool": "voxel.exec",
  "input": {
    "code": "...JavaScript...",
    "gridSize": 256,
    "palette": "simple",
    "seed": 123
  }
}
```

This is raw model output in tool mode. It is not yet the final expanded voxel build.

## 4) Conversion and local run examples

### Convert raw provider output into MineBench build JSON

Use the CLI utility when you have raw OpenAI, Anthropic, or direct tool-envelope JSON:

```bash
pnpm tool:convert --in docs/examples/voxel-exec-tool-call-example.json
pnpm tool:convert --in openai-response.json --out uploads/castle/castle-gpt-5-2-pro.json
cat anthropic-response.json | pnpm tool:convert --out /tmp/build.json
pnpm tool:convert --in raw.json --expanded
```

Accepted inputs include:

- direct tool envelopes
- raw function arguments
- OpenAI Chat/Responses tool-call payloads
- Anthropic `tool_use` blocks

### Execute tool code locally through the dev API

This is useful for testing a small tool payload against the same runtime used by the app:

```bash
curl -sS -X POST "http://localhost:3000/api/local/voxel-exec" \
  -H "Content-Type: application/json" \
  --data '{"code":"box(20,0,20,44,8,44,\"stone\");","gridSize":64,"palette":"simple","seed":123}'
```

In development this endpoint is enabled by default. In production it is disabled unless `MINEBENCH_ENABLE_LOCAL_EXEC_API=1`.

### Generate benchmark files with or without tool mode

```bash
pnpm batch:generate --generate
pnpm batch:generate --generate --notools
pnpm batch:generate --generate --prompt castle --model sonnet
```

Tool mode is the default. `--notools` is a fallback path for debugging or direct-output comparisons.

Each completed provider attempt is written immediately under the prompt's RAW
directory, such as `uploads/arcade/RAW/`. Attempt artifacts use names such as
`arcade-opus-5-RAW-attempt-01.txt`; an attempt that is itself valid JSON uses
the `.json` extension. These files include responses that fail extraction,
tool-call validation, execution, or build validation and trigger another
attempt. A new run for the same prompt and model replaces its prior attempt
artifacts. After generation returns, the unnumbered canonical RAW artifact is
also replaced with the new run's successful or final failed response.

### Import a converted build into the local database

```bash
curl -sS -X POST "http://localhost:3000/api/admin/import-build?modelKey=openai_gpt_5_2_pro&promptText=$(node -p 'encodeURIComponent(process.argv[1])' 'A medieval stone castle')&overwrite=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-binary "@uploads/castle/castle-gpt-5-2-pro.json"
```

For larger production payloads, the recommended path is `pnpm batch:generate --upload ...` with Supabase Storage enabled.

## 5) Runtime behavior and output files

`runVoxelExec(...)` executes model JavaScript in a Node `vm` sandbox with time and primitive-count limits.

The runtime returns its intermediate build in memory. It only writes a diagnostic
tool-run artifact when persistence is explicitly requested through:

1. `outputDir` in a direct `runVoxelExec(...)` call
2. `MINEBENCH_TOOL_OUTPUT_DIR`

This avoids serializing a potentially much larger pre-validation block list during
normal generation. Batch generation already preserves the model's RAW tool call
and the validated final build separately.

Relevant runtime controls:

- `MINEBENCH_TOOL_TIMEOUT_MS`
- `MINEBENCH_TOOL_MAX_BOXES`
- `MINEBENCH_TOOL_MAX_LINES`
- `MINEBENCH_TOOL_MAX_BLOCKS`

## 6) How raw output becomes a final build

### Step A: extract the JSON object from model text

- `extractFirstJsonObject` / `extractBestVoxelBuildJson`
- File: `lib/ai/jsonExtract.ts`

### Step B: validate the tool-call envelope

- `voxelExecToolCallSchema.safeParse(...)`
- File: `lib/ai/tools/voxelExec.ts`

### Step C: execute model JavaScript in the sandbox

- `runVoxelExec(...)`
- File: `lib/ai/tools/voxelExec.ts`

The runtime collects primitives into build spec format:

```json
{
  "version": "1.0",
  "boxes": [...],
  "lines": [...],
  "blocks": [...]
}
```

### Step D: validate, expand, and deduplicate

- `validateVoxelBuild(...)`
- File: `lib/voxel/validate.ts`

Validation does all of this:

- expands `boxes` and `lines` to discrete blocks
- normalizes block IDs, including common aliases
- drops negatives and out-of-bounds coordinates
- drops unknown block types
- deduplicates final coordinates
- enforces block-count and structure limits

### Step E: parse final spec

- `parseVoxelBuildSpec(...)`
- File: `lib/voxel/validate.ts`

### Step F: persist and render

- Persisted in the `Build` table (`prisma/schema.prisma`)
- Loaded by arena, leaderboard, and sandbox APIs
- Rendered via:
  - `lib/voxel/mesh.ts`
  - `components/voxel/VoxelViewer.tsx`

## 7) What to keep straight

There are two different JSON artifacts:

1. Tool-call JSON
   - contains JavaScript code plus tool metadata
2. Voxel build JSON
   - contains `version/boxes/lines/blocks`

MineBench executes the first and stores the second.

## 8) Exporting builds

Arena and Sandbox build cards can export the rendered build to these formats:

- GLB (`.glb`) for Blender and other glTF tools. MineBench writes one glTF material per block type, with `extras.minebenchBlockId` and `extras.minecraftBlockState` metadata so downstream tools can inspect the original block mapping.
- STL (`.stl`) for mesh and print workflows. STL is geometry-only, so block colors and material names are not part of the file.
- Sponge schematic (`.schem`) for Minecraft. MineBench writes gzip-compressed Sponge v3 NBT, with `Width`, `Height`, `Length`, `Offset`, `Blocks.Palette`, and varint-packed `Blocks.Data` indexed as `x + z * Width + y * Width * Length`.
- MagicaVoxel (`.vox`) for voxel-art tools. MineBench writes a single VOX 150 model with `SIZE`, `XYZI`, and `RGBA` chunks. Each block type becomes one palette color using the same representative colors as the GLB materials; original block IDs are not stored.

Exporting uses the same validated `VoxelBuild` shape that the viewer receives. The exporter deduplicates positions, crops the schematic to the occupied bounds, and greedily merges visible faces per block type before writing GLB/STL geometry. This keeps large solid builds small and keeps conversion off the render path by running it in a browser worker.

### Blender

Use the build card Export menu and choose Blender. Import the downloaded `.glb` through Blender's glTF importer. Colors are stored as glTF material base colors. Transparent and cutout blocks are written with matching glTF alpha modes where the source block type supports it.

### Minecraft

Use the build card Export menu and choose Minecraft. MineBench exports `.schem` because it is the practical import format for full MineBench-scale builds through existing tools such as WorldEdit or FAWE. A custom MineBench importer plugin is not needed for the initial workflow.

Typical WorldEdit flow:

```text
1. Put the downloaded file in the WorldEdit schematics folder.
   - Bukkit, Spigot, Paper: plugins/WorldEdit/schematics
   - Fabric, Forge, NeoForge: config/worldedit/schematics
2. Run //schem load <filename>
3. Stand where the build should appear and run //paste
```

For detailed client/server setup, FAWE guidance, Blender import notes, and troubleshooting, see `docs/build-export-import.md`.

### MagicaVoxel

Use the build card Export menu and choose MagicaVoxel, then open the downloaded `.vox` in MagicaVoxel or another VOX reader. Blocks keep their per-type RGBA palette colors, but original block IDs, textures, and emissive behavior are not preserved. A single model supports up to 256 blocks per axis and 255 block types.

Vanilla structure-block `.nbt` export is intentionally not the primary path. It is useful for small structures, but it is a poor default for MineBench's larger grids and would not replace the existing WorldEdit import path.

Reference docs:

- Sponge schematic v3 specification: https://github.com/SpongePowered/Schematic-Specification
- WorldEdit clipboard and schematic storage docs: https://worldedit.enginehub.org/en/latest/usage/clipboard/
- MagicaVoxel VOX format specification: https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt

### Adding formats

Add new export formats under `lib/voxel/export/`, wire them through `components/voxel/voxelBuildExport.worker.ts`, and extend `tests/integration/voxel-export.test.ts`. Format code should not run on viewer mount. Preserve block IDs through materials, metadata, or native block states when the target format supports them; otherwise document the loss explicitly.

## 9) Related docs

- Ranking system: `docs/arena-ranking-system.md`
- Build export and import guide: `docs/build-export-import.md`
- Prompt template: `docs/chatgpt-web-voxel-prompt.md`
