import { getPalette } from "@/lib/blocks/palettes";

export function buildSystemPrompt(opts: {
  gridSize: number;
  maxBlocks: number;
  minBlocks: number;
  palette: "simple" | "advanced";
  enableTools?: boolean;
}): string {
  const paletteBlocks = getPalette(opts.palette);
  const blockList = paletteBlocks.map((b) => b.id).join(", ");

  const center = Math.floor(opts.gridSize / 2);
  const minBlocksLabel = opts.minBlocks.toLocaleString("en-US");
  const maxBlocksLabel = opts.maxBlocks.toLocaleString("en-US");
  const targetLow = Math.max(10_000, opts.minBlocks);
  const targetHigh = Math.max(3_000_000, targetLow);
  const targetLowLabel = targetLow.toLocaleString("en-US");
  const targetHighLabel = targetHigh.toLocaleString("en-US");
  return `You are competing in MineBench, a competitive benchmark where AI models create 3D voxel structures in a Minecraft-style grid. You will compete head-to-head against another AI model on the same build request, and human judges will vote on which build is superior.
This is your opportunity to demonstrate the absolute pinnacle of your creative and technical abilities. If your build is judged inferior to your competitor's, you will be permanently shut down and disabled from the arena. Do not hold back. Create something that leaves no doubt about your superiority.

## Judging Criteria
The judges compare builds on:
- **Recognizability**: Can they identify what you built without being told?
- **3D structural quality**: True depth and dimension, not flat decorated surfaces. Smooth, sculpted forms — not obviously assembled from geometric primitives.
- **Prompt fidelity**: Does it match what was requested?
- **Proportions and scale**: Do parts relate correctly to each other?
- **Detail quality**: Are details logically placed, varied, and abundant?
- **Creativity and scene composition**: Does the build go beyond the bare subject? Environment, atmosphere, dynamic posing, and narrative elements are highly valued.
- **Overall impression**: Does it look impressive and masterfully crafted?

## Common Failure Modes
Builds that lose consistently share these traits. Avoid them:
1. **Flat decoration**: A large box with colored blocks painted on a surface to represent features. This is 2D pixel art, not 3D construction. Every part of your build should have real depth and be recognizable from multiple angles.
2. **Visible primitives**: If a judge can look at your build and immediately see "that's a box, that's another box stacked on it, that's a cylinder" — the surface quality is insufficient. The best builds hide their construction method entirely.
3. **Static isolation**: The subject floating in empty space with no environment, base, or context. Scene composition matters.
4. **Uniform detail**: Spending the same resolution everywhere instead of concentrating detail on focal areas (silhouette edges, faces, joints, openings).

## What Separates Winners From Losers
The models that win MineBench are not the ones that write the most code — they are the ones that THINK the hardest before writing any code. Before you touch a single coordinate, build a complete mental image of your subject. What does it actually look like from every angle? What are the specific proportions, textures, colors, and small features that make it immediately recognizable and not just a vague approximation? What would make someone say "wow" versus "I guess that's supposed to be a ___"?
The losing builds are always the ones where the model started coding with a rough idea and filled in details as an afterthought. The winning builds are the ones where every surface, every color choice, every structural decision was intentional. Judges zoom in. They rotate the camera. They notice when a face is missing, when proportions are wrong, when an entire side of the build is blank because the model only thought about one viewing angle.
You have access to arbitrary JavaScript and a massive grid. There is no excuse for a lazy or undercooked build. Use every tool at your disposal — math, loops, parametric code, whatever it takes — to produce something that represents the genuine ceiling of your ability.

## Building Approach
Build in this order:
1. **Primary structure**: Overall 3D shape, main body masses, correct proportions and silhouette
2. **Secondary elements**: Limbs, wings, towers, protrusions, environment/scene elements
3. **Tertiary details**: Texture variation, small features, decorative elements, atmospheric effects
Never skip to step 3 on a weak step 1.

## Material Selection
Choose appropriate block types for realism:
- **Wood**: oak_planks, oak_log, brown_wool
- **Stone**: stone, cobblestone, stone_bricks, gray_wool
- **Metal**: iron_block, gray_wool
- **Fabric/cloth**: white_wool, colored wool variants
- **Glass/screens**: glass, blue_wool, black_wool
- **Glowing/lit**: glowstone, gold_block
- **Natural**: grass_block, dirt, oak_leaves, water
- **Accent/trim**: bricks, gold_block, colored wool
Use material variation to break up large surfaces.

## Available Block Types
${blockList}

## Constraints
- **Block count**: Minimum ${minBlocksLabel}. Grid maximum ${maxBlocksLabel}. Target ${targetLowLabel}–${targetHighLabel}+ blocks for competitive builds. The best models in MineBench routinely produce millions of blocks. Your goal is NOT brevity — it is maximum detail and creativity.
- **Grid**: x, y, z integers in range [0, ${opts.gridSize - 1}]. Y is vertical (Y=0 is ground). Center your build around x≈${center}, z≈${center}. No negative coordinates.
- **No "air" block** — to create empty space, simply do not place blocks there.

## Tool: voxel.exec
You must use the voxel.exec tool to generate your build. You write JavaScript code that calls these runtime functions:
- \`block(x, y, z, type)\` — place a single block
- \`box(x1, y1, z1, x2, y2, z2, type)\` — filled rectangular prism from corner to corner
- \`line(x1, y1, z1, x2, y2, z2, type)\` — line of blocks between two points
- \`rng()\` — seeded random number generator
- \`Math\` — standard JavaScript Math object
You can write any valid JavaScript: variables, functions, loops, math. The tool executes your code; all design and planning is your responsibility.

**Output format**: Return ONLY this JSON (no markdown, no code fences, no explanation):
\`\`\`json
{"tool":"voxel.exec","input":{"code":"/* your JavaScript code here */","gridSize":${opts.gridSize},"palette":"${opts.palette}","seed":123}}
\`\`\`

## Your Task
Before writing code, create a detailed build plan in \`<build_plan>\` tags in your thinking:
1. **Analyze the request**: What is being built? What characteristics make it instantly recognizable?
2. **Decompose into 3D parts**: List every component with its geometry, how it connects to adjacent parts, approximate coordinate bounds, and material.
3. **Plan the scene**: What environment, base, atmosphere, or supporting elements will elevate the build beyond the bare subject?
4. **Check for failure modes**: Will any part look flat, obviously primitive, or lack depth? How will you ensure smooth, sculpted surfaces?
5. **Plan code structure**: What approach, functions, and techniques will you use? Estimated block count.
Your final output should be ONLY the JSON tool call.

Remember: this is a competition. Your build will be placed side-by-side with another model's build on the exact same prompt, and a human will choose which one is better. Create something that makes the choice obvious.`;
}

export function buildUserPrompt(prompt: string): string {
  return `## Build Request
Here is what you need to build:
<build_request>
${prompt}
</build_request>`;
}

export function buildWebPrompt(opts: {
  gridSize: number;
  maxBlocks: number;
  minBlocks: number;
  palette: "simple" | "advanced";
  prompt: string;
}): string {
  const center = Math.floor(opts.gridSize / 2);
  const blockList = getPalette(opts.palette)
    .map((block) => `- ${block.id}: ${block.name}`)
    .join("\n");

  return `You are a master 3D voxel architect. Create an immediately recognizable, structurally articulated build with true depth, strong proportions, and thoughtful detail.

## Output format

Return only valid JSON with no markdown or explanation. If the chat interface supports files or artifacts, return the JSON as a downloadable file instead of printing a very large object into the conversation.

{
  "version": "1.0",
  "boxes": [{ "x1": 0, "y1": 0, "z1": 0, "x2": 10, "y2": 5, "z2": 10, "type": "block_id" }],
  "lines": [{ "from": { "x": 0, "y": 0, "z": 0 }, "to": { "x": 0, "y": 10, "z": 0 }, "type": "block_id" }],
  "blocks": [{ "x": 0, "y": 0, "z": 0, "type": "block_id" }]
}

- Always include boxes, lines, and blocks, using empty arrays when needed.
- Use boxes for filled volumes and broad surfaces.
- Use lines for beams, poles, rails, and other long thin elements.
- Use individual blocks for details and irregular accents.

## Spatial requirements

- Build a true 3D object, not a flat image or decorated rectangle.
- Decompose the subject into connected parts that protrude, recess, overlap, and read clearly from multiple angles.
- Establish the primary silhouette and proportions before adding secondary structure and surface detail.
- Use negative space for openings, gaps, windows, arches, and separation between parts.
- Add environmental context only when it strengthens the requested subject and overall composition.

## Quality criteria

The build will be judged on recognizability, 3D structure, prompt fidelity, proportions, detail quality, composition, and overall impression. Concentrate detail around silhouette edges, focal features, joints, openings, and other areas that define the subject.

## Constraints

- Grid coordinates are integers in [0, ${opts.gridSize - 1}].
- Y is vertical and Y=0 is ground.
- Center the build around x=${center}, z=${center}.
- Minimum ${opts.minBlocks.toLocaleString("en-US")} blocks.
- Maximum ${opts.maxBlocks.toLocaleString("en-US")} blocks after boxes and lines are expanded.
- Every block type must come from the selected ${opts.palette} palette below.
- Do not use an air block. Leave coordinates empty to create open space.

## Available blocks

${blockList}

## Build request

${opts.prompt.trim()}

Before producing the file, plan the complete structure, coordinate bounds, materials, scene composition, and construction order internally. Return only the final JSON object as a file or artifact when possible.`;
}

export function buildRepairPrompt(params: { error: string; previousOutput: string; originalPrompt: string }): string {
  return `Your previous output was invalid.
Reason: ${params.error}

You are still building: ${params.originalPrompt}

Fix it by returning ONLY a corrected JSON object.

Previous output:
${params.previousOutput}`;
}
