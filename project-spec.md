# MineBench: AI Model 3D Construction Benchmark

## Project Overview

MineBench is a web application that benchmarks AI models' spatial reasoning abilities by comparing their 3D voxel constructions. Users enter natural language prompts (e.g., "a pirate ship", "medieval castle"), select which AI models to compare, and view side-by-side interactive 3D renders of each model's interpretation.

**Research Angle:** This serves as a novel benchmark for evaluating LLM spatial reasoning, prompt-to-3D coherence, and creative construction abilities—an underexplored area in AI evaluation.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| 3D Rendering | Three.js |
| Database | PostgreSQL (via Prisma ORM) |
| Deployment | Vercel |
| AI Providers | OpenAI, Anthropic, Google Gemini, Ollama (for Llama) |

---

## Core User Flow

1. User lands on homepage
2. User enters a construction prompt in the input field
3. User selects block palette (Simple or Advanced)
4. User selects which models to compare (checkboxes)
5. User clicks "Generate"
6. Loading state shows progress for each model (parallel API calls)
7. Results render as side-by-side 3D voxel viewers
8. User can rotate/zoom/pan each model independently
9. User can save to gallery (optional)
10. User can vote on best interpretation (optional, for future ELO system)

---

## Project Structure

```
voxel-arena/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                    # Homepage with prompt input
│   ├── generate/
│   │   └── page.tsx                # Results page with 3D viewers
│   ├── gallery/
│   │   └── page.tsx                # Public gallery of saved builds
│   ├── api/
│   │   ├── generate/
│   │   │   └── route.ts            # Main generation endpoint
│   │   ├── models/
│   │   │   ├── openai/route.ts
│   │   │   ├── anthropic/route.ts
│   │   │   ├── gemini/route.ts
│   │   │   └── ollama/route.ts
│   │   ├── gallery/
│   │   │   └── route.ts            # CRUD for gallery
│   │   └── vote/
│   │       └── route.ts            # Voting endpoint
│   └── globals.css
├── components/
│   ├── ui/
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Select.tsx
│   │   ├── Card.tsx
│   │   ├── Checkbox.tsx
│   │   └── LoadingSpinner.tsx
│   ├── PromptForm.tsx              # Main input form
│   ├── ModelSelector.tsx           # Model checkboxes
│   ├── PaletteSelector.tsx         # Simple/Advanced toggle
│   ├── VoxelViewer.tsx             # Three.js 3D viewer component
│   ├── VoxelGrid.tsx               # Grid of multiple viewers
│   ├── GenerationCard.tsx          # Single model result card
│   └── GalleryGrid.tsx             # Gallery display
├── lib/
│   ├── prisma.ts                   # Prisma client
│   ├── voxel-schema.ts             # TypeScript types for voxel data
│   ├── block-palettes.ts           # Block definitions
│   ├── prompt-templates.ts         # System prompts for each model
│   ├── three-utils.ts              # Three.js helper functions
│   └── model-clients.ts            # AI API client wrappers
├── prisma/
│   └── schema.prisma
├── public/
│   └── textures/                   # Minecraft-style block textures
├── .env.local
├── tailwind.config.ts
├── next.config.js
├── package.json
└── README.md
```

---

## Database Schema (Prisma)

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Generation {
  id          String   @id @default(cuid())
  prompt      String
  palette     String   // "simple" or "advanced"
  createdAt   DateTime @default(now())
  
  results     ModelResult[]
  votes       Vote[]
  
  // For gallery
  isPublic    Boolean  @default(false)
  title       String?  // Optional user-given title
}

model ModelResult {
  id            String   @id @default(cuid())
  generationId  String
  generation    Generation @relation(fields: [generationId], references: [id], onDelete: Cascade)
  
  modelProvider String   // "openai", "anthropic", "gemini", "ollama"
  modelName     String   // "gpt-4o", "claude-sonnet-4-20250514", etc.
  
  voxelData     Json     // The full voxel JSON output
  blockCount    Int
  
  // Metadata
  generationTimeMs Int
  tokenCount       Int?
  
  // Computed metrics (for research)
  symmetryScore    Float?
  boundingBox      Json?   // {x: n, y: n, z: n}
  
  votes         Vote[]
  
  createdAt     DateTime @default(now())
}

model Vote {
  id              String   @id @default(cuid())
  
  generationId    String
  generation      Generation @relation(fields: [generationId], references: [id], onDelete: Cascade)
  
  modelResultId   String
  modelResult     ModelResult @relation(fields: [modelResultId], references: [id], onDelete: Cascade)
  
  // Anonymous voter tracking (session-based)
  sessionId       String
  
  createdAt       DateTime @default(now())
  
  @@unique([generationId, sessionId]) // One vote per generation per session
}
```

---

## Voxel Data Schema

```typescript
// lib/voxel-schema.ts

export interface Block {
  x: number;        // 0 to 127
  y: number;        // 0 to 127 (y is vertical/height)
  z: number;        // 0 to 127
  type: string;     // Block type ID from palette
}

export interface VoxelBuild {
  version: "1.0";
  metadata: {
    prompt: string;
    palette: "simple" | "advanced";
    modelProvider: string;
    modelName: string;
    generatedAt: string;  // ISO timestamp
  };
  bounds: {
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  blocks: Block[];
}

// Validation constants
export const MAX_GRID_SIZE = 128;
export const MAX_BLOCKS = 50000; // Reasonable limit for rendering performance
```

---

## Block Palettes

```typescript
// lib/block-palettes.ts

export interface BlockDefinition {
  id: string;
  name: string;
  color: string;        // Hex color for rendering
  category: string;
  textureTop?: string;  // Optional texture paths
  textureSide?: string;
  textureBottom?: string;
}

export const SIMPLE_PALETTE: BlockDefinition[] = [
  // Basic building (10 blocks)
  { id: "stone", name: "Stone", color: "#8B8B8B", category: "building" },
  { id: "cobblestone", name: "Cobblestone", color: "#6B6B6B", category: "building" },
  { id: "oak_planks", name: "Oak Planks", color: "#B8945F", category: "building" },
  { id: "brick", name: "Brick", color: "#9B4D3A", category: "building" },
  
  // Nature (6 blocks)
  { id: "grass_block", name: "Grass Block", color: "#5D8C3E", category: "nature" },
  { id: "dirt", name: "Dirt", color: "#8B6344", category: "nature" },
  { id: "sand", name: "Sand", color: "#E5D9A8", category: "nature" },
  { id: "oak_log", name: "Oak Log", color: "#6B5028", category: "nature" },
  { id: "oak_leaves", name: "Oak Leaves", color: "#4A7A26", category: "nature" },
  { id: "water", name: "Water", color: "#3F76E4", category: "nature" },
  
  // Colors (8 blocks)
  { id: "white_wool", name: "White Wool", color: "#FFFFFF", category: "colors" },
  { id: "black_wool", name: "Black Wool", color: "#1D1D21", category: "colors" },
  { id: "red_wool", name: "Red Wool", color: "#A12722", category: "colors" },
  { id: "blue_wool", name: "Blue Wool", color: "#35399D", category: "colors" },
  { id: "green_wool", name: "Green Wool", color: "#546D1B", category: "colors" },
  { id: "yellow_wool", name: "Yellow Wool", color: "#F9C627", category: "colors" },
  { id: "orange_wool", name: "Orange Wool", color: "#F07613", category: "colors" },
  { id: "purple_wool", name: "Purple Wool", color: "#7B2FBE", category: "colors" },
  
  // Utility (4 blocks)
  { id: "glass", name: "Glass", color: "#C0D6E4", category: "utility" },
  { id: "glowstone", name: "Glowstone", color: "#FFDA74", category: "utility" },
  { id: "iron_block", name: "Iron Block", color: "#D8D8D8", category: "utility" },
  { id: "gold_block", name: "Gold Block", color: "#F9D849", category: "utility" },
];
// Total: 28 blocks

export const ADVANCED_PALETTE: BlockDefinition[] = [
  ...SIMPLE_PALETTE,
  
  // Additional building materials (20 blocks)
  { id: "stone_bricks", name: "Stone Bricks", color: "#7A7A7A", category: "building" },
  { id: "mossy_stone_bricks", name: "Mossy Stone Bricks", color: "#6B7A5A", category: "building" },
  { id: "cracked_stone_bricks", name: "Cracked Stone Bricks", color: "#767676", category: "building" },
  { id: "granite", name: "Granite", color: "#956756", category: "building" },
  { id: "diorite", name: "Diorite", color: "#BFBFBF", category: "building" },
  { id: "andesite", name: "Andesite", color: "#888888", category: "building" },
  { id: "deepslate", name: "Deepslate", color: "#4D4D4D", category: "building" },
  { id: "spruce_planks", name: "Spruce Planks", color: "#6B5028", category: "building" },
  { id: "birch_planks", name: "Birch Planks", color: "#C8B77A", category: "building" },
  { id: "dark_oak_planks", name: "Dark Oak Planks", color: "#3E2912", category: "building" },
  { id: "spruce_log", name: "Spruce Log", color: "#3B2810", category: "building" },
  { id: "birch_log", name: "Birch Log", color: "#D5CDA4", category: "building" },
  { id: "quartz_block", name: "Quartz Block", color: "#EDE5DD", category: "building" },
  { id: "smooth_stone", name: "Smooth Stone", color: "#9E9E9E", category: "building" },
  { id: "sandstone", name: "Sandstone", color: "#D8CB99", category: "building" },
  { id: "red_sandstone", name: "Red Sandstone", color: "#BA6626", category: "building" },
  { id: "nether_bricks", name: "Nether Bricks", color: "#2D1117", category: "building" },
  { id: "prismarine", name: "Prismarine", color: "#63A394", category: "building" },
  { id: "terracotta", name: "Terracotta", color: "#985E43", category: "building" },
  { id: "concrete", name: "White Concrete", color: "#CFD5D6", category: "building" },
  
  // Additional nature (10 blocks)
  { id: "gravel", name: "Gravel", color: "#827F7E", category: "nature" },
  { id: "clay", name: "Clay", color: "#9EA4B0", category: "nature" },
  { id: "snow", name: "Snow", color: "#FAFAFA", category: "nature" },
  { id: "ice", name: "Ice", color: "#91B4FE", category: "nature" },
  { id: "packed_ice", name: "Packed Ice", color: "#7DA1E8", category: "nature" },
  { id: "moss_block", name: "Moss Block", color: "#596D28", category: "nature" },
  { id: "flowering_azalea_leaves", name: "Flowering Azalea", color: "#6B8E4E", category: "nature" },
  { id: "lava", name: "Lava", color: "#CF5A00", category: "nature" },
  { id: "soul_sand", name: "Soul Sand", color: "#513E32", category: "nature" },
  { id: "netherrack", name: "Netherrack", color: "#6B3333", category: "nature" },
  
  // Additional colors (16 blocks - remaining wool colors)
  { id: "gray_wool", name: "Gray Wool", color: "#3E4447", category: "colors" },
  { id: "light_gray_wool", name: "Light Gray Wool", color: "#8E8E86", category: "colors" },
  { id: "cyan_wool", name: "Cyan Wool", color: "#157788", category: "colors" },
  { id: "light_blue_wool", name: "Light Blue Wool", color: "#3AAFD9", category: "colors" },
  { id: "lime_wool", name: "Lime Wool", color: "#70B919", category: "colors" },
  { id: "magenta_wool", name: "Magenta Wool", color: "#BD44B3", category: "colors" },
  { id: "pink_wool", name: "Pink Wool", color: "#ED8DAC", category: "colors" },
  { id: "brown_wool", name: "Brown Wool", color: "#724728", category: "colors" },
  { id: "red_concrete", name: "Red Concrete", color: "#8E2020", category: "colors" },
  { id: "blue_concrete", name: "Blue Concrete", color: "#2C2E8F", category: "colors" },
  { id: "green_concrete", name: "Green Concrete", color: "#495B24", category: "colors" },
  { id: "yellow_concrete", name: "Yellow Concrete", color: "#E9C12F", category: "colors" },
  { id: "black_concrete", name: "Black Concrete", color: "#080A0F", category: "colors" },
  { id: "white_concrete", name: "White Concrete", color: "#CFD5D6", category: "colors" },
  { id: "copper_block", name: "Copper Block", color: "#C06E4E", category: "colors" },
  { id: "oxidized_copper", name: "Oxidized Copper", color: "#4F9E8E", category: "colors" },
  
  // Additional utility/special (10 blocks)
  { id: "obsidian", name: "Obsidian", color: "#0F0A18", category: "utility" },
  { id: "crying_obsidian", name: "Crying Obsidian", color: "#200A28", category: "utility" },
  { id: "sea_lantern", name: "Sea Lantern", color: "#A8D5D8", category: "utility" },
  { id: "redstone_block", name: "Redstone Block", color: "#A81E09", category: "utility" },
  { id: "emerald_block", name: "Emerald Block", color: "#2ABB4B", category: "utility" },
  { id: "diamond_block", name: "Diamond Block", color: "#62DBD4", category: "utility" },
  { id: "lapis_block", name: "Lapis Block", color: "#1D47A0", category: "utility" },
  { id: "tinted_glass", name: "Tinted Glass", color: "#2D2930", category: "utility" },
  { id: "amethyst_block", name: "Amethyst Block", color: "#8561B8", category: "utility" },
  { id: "ancient_debris", name: "Ancient Debris", color: "#5E4238", category: "utility" },
];
// Total: ~84 blocks
```

---

## API Endpoints

### POST /api/generate

Main endpoint that orchestrates generation across multiple models.

**Request:**
```typescript
{
  prompt: string;
  palette: "simple" | "advanced";
  models: string[];  // ["openai", "anthropic", "gemini", "ollama"]
}
```

**Response:**
```typescript
{
  generationId: string;
  results: {
    modelProvider: string;
    modelName: string;
    status: "success" | "error";
    voxelData?: VoxelBuild;
    error?: string;
    generationTimeMs: number;
  }[];
}
```

### Individual Model Endpoints

Each model has its own endpoint for modularity:
- `POST /api/models/openai`
- `POST /api/models/anthropic`
- `POST /api/models/gemini`
- `POST /api/models/ollama`

All accept the same request format and return a `VoxelBuild` or error.

### Gallery Endpoints

- `GET /api/gallery` - List public gallery items (paginated)
- `POST /api/gallery` - Save a generation to gallery
- `DELETE /api/gallery/[id]` - Remove from gallery

### Voting Endpoint

- `POST /api/vote` - Cast a vote for best model in a generation

---

## Prompt Templates

```typescript
// lib/prompt-templates.ts

export function buildSystemPrompt(palette: "simple" | "advanced"): string {
  const paletteBlocks = palette === "simple" ? SIMPLE_PALETTE : ADVANCED_PALETTE;
  const blockList = paletteBlocks.map(b => `- ${b.id}: ${b.name}`).join("\n");
  
  return `You are a 3D voxel construction AI. Your task is to create 3D structures in a Minecraft-style voxel format.

## Output Format
You must respond with ONLY valid JSON matching this exact schema:
{
  "version": "1.0",
  "blocks": [
    {"x": 0, "y": 0, "z": 0, "type": "block_id"},
    ...
  ]
}

## Coordinate System
- X axis: left (-) to right (+)
- Y axis: down (-) to up (+) - Y=0 is ground level
- Z axis: back (-) to front (+)
- Maximum grid size: 128x128x128 (coordinates 0-127)
- Build on the ground starting at Y=0

## Available Blocks
${blockList}

## Construction Guidelines
1. Create structurally coherent builds that match the prompt
2. Use appropriate blocks for different parts (e.g., wood for hulls, wool for sails)
3. Consider symmetry and proportions
4. Add details that bring the build to life
5. Keep builds reasonably sized (typically 20-60 blocks in each dimension)
6. Ensure the structure is complete and recognizable
7. Use block variety appropriately - don't just use one block type

## Critical Rules
- Output ONLY the JSON object, no markdown, no explanation
- Every block must have valid x, y, z coordinates (integers 0-127)
- Every block type must be from the available blocks list above
- Do not exceed 50,000 total blocks
- The build should be centered roughly around x=64, z=64`;
}

export function buildUserPrompt(prompt: string): string {
  return `Build the following: ${prompt}

Remember: Output ONLY valid JSON with the blocks array. No other text.`;
}
```

---

## Three.js Voxel Renderer

```typescript
// lib/three-utils.ts

// Key functions needed:

export function createVoxelScene(container: HTMLElement): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
};

export function renderVoxelBuild(
  scene: THREE.Scene,
  build: VoxelBuild,
  palette: BlockDefinition[]
): THREE.Group;

export function clearScene(scene: THREE.Scene): void;

export function setupLighting(scene: THREE.Scene): void;

export function createBlockMesh(
  block: Block,
  blockDef: BlockDefinition
): THREE.Mesh;

// Use instanced meshes for performance with many blocks
export function createInstancedVoxels(
  blocks: Block[],
  palette: BlockDefinition[]
): THREE.InstancedMesh[];
```

---

## Key Components

### VoxelViewer.tsx

Interactive 3D viewer for a single model's output.

```typescript
interface VoxelViewerProps {
  voxelData: VoxelBuild | null;
  isLoading: boolean;
  error?: string;
  modelName: string;
  modelProvider: string;
  palette: "simple" | "advanced";
}
```

Features:
- Orbit controls (rotate, zoom, pan)
- Grid floor for reference
- Block count display
- Generation time display
- Fullscreen toggle
- Reset camera button

### PromptForm.tsx

Main input form on homepage.

Features:
- Textarea for prompt input
- Character count
- Example prompts as clickable chips
- Submit button with loading state

### ModelSelector.tsx

Model selection with checkboxes.

Features:
- Grouped by provider
- Select all / deselect all
- Show model icons/logos
- Disabled state for unavailable models

### PaletteSelector.tsx

Simple toggle or segmented control.

Features:
- Simple vs Advanced toggle
- Tooltip explaining the difference
- Block count indicator

---

## Environment Variables

```env
# .env.local

# Database
DATABASE_URL="postgresql://..."

# AI Providers
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."
GOOGLE_AI_API_KEY="..."

# Ollama (if running locally or on a server)
OLLAMA_BASE_URL="http://localhost:11434"

# App
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

---

## Implementation Phases

### Phase 1: Core MVP (Priority)
1. Project setup (Next.js, Tailwind, TypeScript)
2. Basic UI components
3. Block palette definitions
4. Single model integration (start with Claude)
5. Basic Three.js voxel renderer
6. Prompt input → JSON output → 3D render pipeline

### Phase 2: Multi-Model Comparison
1. Add remaining AI providers (OpenAI, Gemini, Ollama)
2. Parallel generation
3. Side-by-side viewer grid
4. Loading states and error handling

### Phase 3: Persistence & Gallery
1. Database setup (Prisma + PostgreSQL)
2. Save generations
3. Public gallery page
4. Share links for generations

### Phase 4: Polish & UX
1. Improved 3D rendering (textures, lighting, shadows)
2. Animations (camera, block placement)
3. Responsive design
4. Keyboard shortcuts
5. Example prompts / inspiration

### Phase 5: Research Features
1. Voting system
2. Automated metrics (symmetry, block diversity, etc.)
3. Leaderboard / ELO rankings
4. Export data for analysis

---

## Design Guidelines

### Visual Style
- Dark theme primary (easier on eyes, makes 3D pop)
- Accent color: vibrant purple or cyan (techy, modern)
- Clean, minimal UI - let the 3D builds be the focus
- Subtle glassmorphism for cards
- Smooth animations and transitions

### Typography
- Sans-serif for UI (Inter or similar)
- Monospace for technical info (generation times, block counts)

### Layout
- Homepage: centered prompt input, prominent CTA
- Results page: grid of viewers (2x2 for 4 models, responsive)
- Gallery: masonry or grid layout with hover previews

---

## Example Prompts (for inspiration section)

- "A pirate ship with sails"
- "Medieval castle with towers"
- "Cozy treehouse"
- "Japanese pagoda"
- "Spaceship"
- "Underwater temple"
- "Viking longship"
- "Wizard tower"
- "Modern skyscraper"
- "Dragon"
- "Lighthouse on rocky coast"
- "Mushroom house"

---

## Future Considerations

- **User accounts**: Save personal builds, track history
- **Custom palettes**: Let users create their own block sets
- **Animation**: Show blocks being placed sequentially
- **Export**: Download as .schematic file for actual Minecraft
- **Benchmark dataset**: Curated set of prompts for standardized testing
- **API access**: Let researchers query the benchmark programmatically
- **Model fine-tuning data**: Use highly-voted builds as training data

---

## Success Metrics

- **Technical**: < 30s generation time, smooth 60fps rendering
- **Engagement**: Users generate multiple prompts per session
- **Research**: Clear differentiation in model capabilities visible
- **Portfolio**: Impressive enough to discuss in interviews

---

This spec should give an AI coding agent everything needed to build the complete application. Start with Phase 1 and iterate.
