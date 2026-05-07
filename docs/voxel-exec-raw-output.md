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

### Import a converted build into the local database

```bash
curl -sS -X POST "http://localhost:3000/api/admin/import-build?modelKey=openai_gpt_5_2_pro&promptText=$(node -p 'encodeURIComponent(process.argv[1])' 'A medieval stone castle')&overwrite=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-binary "@uploads/castle/castle-gpt-5-2-pro.json"
```

For larger production payloads, the recommended path is `pnpm batch:generate --upload ...` with Supabase Storage enabled.

## 5) Runtime behavior and output files

`runVoxelExec(...)` executes model JavaScript in a Node `vm` sandbox with time and primitive-count limits.

By default the runtime writes a build artifact to one of these locations:

1. `MINEBENCH_TOOL_OUTPUT_DIR` if set
2. `uploads/tool-runs/`
3. the system temp directory fallback

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

Vanilla structure-block `.nbt` export is intentionally not the primary path. It is useful for small structures, but it is a poor default for MineBench's larger grids and would not replace the existing WorldEdit import path.

Reference docs:

- Sponge schematic v3 specification: https://github.com/SpongePowered/Schematic-Specification
- WorldEdit clipboard and schematic storage docs: https://worldedit.enginehub.org/en/latest/usage/clipboard/

### Adding formats

Add new export formats under `lib/voxel/export/`, wire them through `components/voxel/voxelBuildExport.worker.ts`, and extend `scripts/verify-voxel-export.ts`. Format code should not run on viewer mount, and it should preserve the block ID mapping either as materials, metadata, or the native block-state representation.

## 9) Related docs

- Ranking system: `docs/arena-ranking-system.md`
- Policy layer: `docs/arena-ranking-validity-policy-v2.md`
- Build export and import guide: `docs/build-export-import.md`
- Prompt template: `docs/chatgpt-web-voxel-prompt.md`
