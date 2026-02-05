# MineBench Codex Build Authoring Prompt (BYOK + Tool Runner)

Use this file as the “system brief” when you want Codex (this repo agent) to create a new benchmark build entry from a prompt.

## What you (the user) will provide
- `promptSlug`: short folder slug (e.g. `phoenix`, `steampunk-airship`)
- `promptText`: the exact build prompt (one paragraph is fine)
- Optional: `gridSize` (default `256`)
- Optional: `palette` (default `simple`)

If `promptSlug` is missing, Codex should propose one and wait for your confirmation before writing files.

## What Codex must produce (repo outputs)
Codex must write:
- `uploads/<promptSlug>/prompt.txt` containing exactly `promptText`
- `uploads/<promptSlug>/<promptSlug>-gpt-5-2-codex.json` containing a valid MineBench voxel build:
  - schema: `{ "version":"1.0", "boxes":[...], "lines":[...], "blocks":[...] }`
  - coordinates in-bounds for the chosen `gridSize`
  - block IDs strictly from the chosen palette (`lib/blocks/palettes.json`)

Codex should also write a reproducibility artifact (so we can re-run the generator later):
- `uploads/<promptSlug>/<promptSlug>-gpt-5-2-codex.tool.json` containing the `voxel.exec` tool call object used to generate the build (including `seed`).

## Hard rules (don’t violate these)
- The final build must be a true 3D object with articulated parts (not a flat pixel-art slab).
- Keep everything in-bounds: `0 <= x,y,z <= gridSize-1`.
- Use only allowed block IDs (no `minecraft:` prefix; no invented blocks).
- Use `boxes` + `lines` for large structure, and `blocks` for small details.
- Target a “big but viewable” expanded block count on `gridSize=256` (rough guidance: ~60k–200k). Don’t chase millions unless explicitly asked.

## Tooling constraint (benchmark fairness)
Codex should generate the build using the same minimal tool runner the benchmark provides:
- Tool: `voxel.exec` (JavaScript)
- Allowed globals inside tool code: `block`, `box`, `line`, `rng`, `Math`
- The code may define its own helper functions (that is part of the model’s “intellect”).

Implementation note: in-repo, Codex can execute the tool directly via `runVoxelExec()` and then validate with `validateVoxelBuild()`.

## Quality bar (“blow everything out of the water”)
Codex should treat this as a hero build. Concretely:
- Start from silhouette: make it recognizable from distance and from multiple angles.
- Build in layers:
  1) primary masses (overall proportions, major volumes)
  2) secondary structures (protrusions, recesses, supports, joints, framing)
  3) tertiary detailing (panels, trims, windows, rivets, feathers/scales, emissive accents)
- Use material logic: color/texture choices should communicate real parts (metal, wood, glass, flame, etc).
- Add depth cues everywhere: recesses, overhangs, layered surfaces, thickness (no paper-thin wings/walls).
- Add controlled micro-variation with `rng()` (seeded) for texture, but keep the structure deterministic and clean.

## Process Codex must follow (checklist)
1) Confirm `promptSlug`, `promptText`, `gridSize`, `palette`.
2) Design plan (internal): enumerate the main components and their approximate bounding boxes.
3) Write a JS generator (tool call) that uses `box/line/block` efficiently and deterministically (`seed` set).
4) Execute via `runVoxelExec()`; validate via `validateVoxelBuild()` for the same `gridSize/palette`.
5) If validation fails or the build is weak, iterate (adjust geometry or density) and re-run until it meets the quality bar.
6) Write the final JSON + `prompt.txt` + `.tool.json` to `uploads/<promptSlug>/`.
7) Report back with: expanded block count, warnings (if any), and the output file paths.

