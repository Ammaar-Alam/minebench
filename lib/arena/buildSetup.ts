export type BuildSetup = { gridSize: number; palette: string };

// every arena prompt uses one of these; benchmark prompts keep the default
export const ARENA_BUILD_SETUPS = [
  { gridSize: 256, palette: "simple" },
  { gridSize: 256, palette: "advanced" },
  { gridSize: 512, palette: "simple" },
  { gridSize: 512, palette: "advanced" },
] as const satisfies readonly BuildSetup[];

export const DEFAULT_ARENA_BUILD_SETUP = ARENA_BUILD_SETUPS[0];

export function isArenaBuildSetup(setup: BuildSetup): boolean {
  return ARENA_BUILD_SETUPS.some(({ gridSize, palette }) => gridSize === setup.gridSize && palette === setup.palette);
}

export function formatBuildSetup({ gridSize, palette }: BuildSetup): string {
  return `${gridSize} · ${palette === "advanced" ? "Advanced" : "Simple"}`;
}

// Sandbox opens a prompt with the setup its arena builds use
export function sandboxPromptHref(prompt: string, setup: BuildSetup | null): string {
  const params = new URLSearchParams({ mode: "live", prompt });
  if (setup) {
    params.set("gridSize", String(setup.gridSize));
    params.set("palette", setup.palette);
  }
  return `/sandbox?${params}`;
}
