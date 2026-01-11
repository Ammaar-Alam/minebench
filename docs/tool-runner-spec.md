# MineBench Tool Runner Spec (Cross-Provider)

## Status
Draft (requested before implementation)

## Goal
Enable a cross-provider tool runner so **all models** (OpenAI, Anthropic, Gemini, etc.) can use the **same minimal code-execution tool** to generate very large voxel builds without being limited by output token caps. This is needed because some existing benchmark builds were produced via web UIs that allow tool/code use, and comparing raw API output without tools would be unfair.

## Benchmark Philosophy
- We want to measure **model intelligence**, not tool intelligence.
- Tools must **remove output-length constraints** but must **not add domain logic** or high-level helpers that solve the task for the model.
- The model should do all planning, geometry reasoning, and design decisions.

This makes the benchmark closer to the web UI experience while still attributing the actual reasoning to the model.

## Scope
- Add a **single universal tool** available to all models.
- Tool will execute model-provided **JavaScript**.
- Tool will expose only **low-level voxel primitives** (block/box/line) and basic JS language features.
- No high-level scene helpers (e.g., castle(), tree(), sphere(), noiseScatter()).
- Models may build their own helpers in code if they are capable.

## Tool Definition (Conceptual)
### Tool name
`voxel.exec`

### Inputs
- `code` (string, required): JavaScript source to generate a voxel build.
- `gridSize` (number, required): 64 | 256 | 512.
- `palette` (string, required): "simple" | "advanced".
- `seed` (number, optional): Seed for deterministic randomness.

### Runtime-provided globals
- `block(x, y, z, type)`
- `box(x1, y1, z1, x2, y2, z2, type)`
- `line(x1, y1, z1, x2, y2, z2, type)`
- `Math` (standard JS)
- `rng()` (seeded RNG if seed is provided; otherwise nondeterministic)

### Output
The tool **writes a build file** and returns metadata, not the full build payload.
- File format: JSON in the existing MineBench build schema.
- Return value:
  ```json
  {
    "filePath": "...",
    "blockCount": 123456,
    "boxCount": 120,
    "lineCount": 300,
    "seed": 123
  }
  ```

## Why file output (not direct JSON)
- Prevents output token limits from truncating large builds.
- Matches web UI behavior (code execution generates data files).
- Ensures large builds are possible across all providers.

## Validation
- Use existing server-side validation (`validateVoxelBuild`) on the tool output.
- Enforce `MAX_BLOCKS_BY_GRID` limits (same as current pipeline).
- Reject invalid block types or out-of-bounds coordinates as today.

## Prompting Rules (Tool-Enabled)
- System prompt should instruct models to **use the tool** when build size is large.
- For fairness, tools are **enabled by default** for all models.
- Provide `--notools` CLI flag to disable tool usage.

## Non-Goals
- No model-specific tool advantages.
- No separate tools per provider.
- No built-in shape generators or procedural scene templates.

## Expected Benefits
- Fairer cross-model comparisons with existing web-UI-generated baselines.
- Removes output-length bias.
- Highlights model reasoning quality and planning ability.

## Risks / Considerations
- Tool-enabled benchmarks are **not raw LLM-only**. This should be documented.
- Execution safety: code must be sandboxed.
- Runtime should avoid infinite loops and memory abuse.
- Determinism: seed support helps reproduce runs.

## Implementation Notes (Non-binding)
- Provide a JS sandbox (e.g., Node `vm`) with a strict API surface.
- Enforce a maximum output size using `MAX_BLOCKS_BY_GRID` and existing validation.
- Keep tool response small (metadata only).

## CLI Behavior
- Default: tools ON
- `--notools`: disable tool usage for a run

## Open Questions
1) Should tool output require an additional “finalization” model response, or is tool output final?
2) Do we need per-provider rate limits or concurrency caps when tools are on?
3) Should the tool write to a separate `.tool.json` path or overwrite normal build output?

