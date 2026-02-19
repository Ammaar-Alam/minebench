# Voxel Exec and Raw Output Pipeline

This document explains what the `voxel.exec` tool is, what primitives models get, what raw model output looks like, and how that becomes a final build JSON in MineBench.

Default runtime behavior in MineBench: model generations run in `voxel.exec` tool mode. The persisted/rendered artifact is always final voxel build JSON (`version/boxes/lines/blocks`).

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

## 2) Primitives available to model code

Inside tool-mode code, models can use:

- `block(x, y, z, type)`
- `box(x1, y1, z1, x2, y2, z2, type)`
- `line(x1, y1, z1, x2, y2, z2, type)`
- `rng()` (seeded when seed is provided)
- `Math`
- constants: `GRID_SIZE`, `PALETTE`

That is intentionally minimal: the model must do planning/design itself.

## 3) Raw model output example

MineBench includes a real tool-call payload example:

- File: [`model-raw-output-example.json`](../model-raw-output-example.json)

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

This is the raw model output in tool mode. It is not yet the final expanded voxel build.

## 4) How raw output becomes a build JSON

### Step A: extract the JSON object from model text

- `extractFirstJsonObject` / `extractBestVoxelBuildJson`
- File: `lib/ai/jsonExtract.ts`

### Step B: validate tool-call envelope

- `voxelExecToolCallSchema.safeParse(...)`
- File: `lib/ai/tools/voxelExec.ts`

### Step C: execute model JS in sandbox

- `runVoxelExec(...)`
- File: `lib/ai/tools/voxelExec.ts`

The runtime collects raw primitives into build spec format:

```json
{
  "version": "1.0",
  "boxes": [...],
  "lines": [...],
  "blocks": [...]
}
```

### Step D: validate/expand/deduplicate

- `validateVoxelBuild(...)`
- File: `lib/voxel/validate.ts`

Validation does all of this:

- expands `boxes` and `lines` to discrete blocks
- normalizes block IDs (including common aliases)
- drops negatives / out-of-bounds
- drops unknown block types
- deduplicates final coordinates
- enforces max block count

### Step E: parse final spec

- `parseVoxelBuildSpec(...)`
- File: `lib/voxel/validate.ts`

### Step F: persist and render

- Persisted in `Build` table (`prisma/schema.prisma`)
- Loaded by arena/sandbox APIs
- Rendered via voxel mesh pipeline:
  - `lib/voxel/mesh.ts`
  - `components/voxel/VoxelViewer.tsx`

## 5) What users should understand

There are two different JSON artifacts:

1. Tool-call JSON (raw model output in tool mode)
   - contains JS code and tool metadata.
2. Voxel build JSON (post-exec build spec)
   - contains `version/boxes/lines/blocks`.

The app executes (1), validates it, and produces (2) for storage/rendering.

Note: direct (non-tool) generation exists as an explicit fallback/dev path, not the default arena/sandbox generation flow.

## 6) Related docs

- Ranking system: `docs/arena-ranking-system.md`
- Policy layer: `docs/arena-ranking-validity-policy-v2.md`
- Tool spec background: `docs/tool-runner-spec.md`
