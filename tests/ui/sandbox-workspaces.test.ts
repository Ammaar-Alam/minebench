import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sandboxSource = readFileSync("components/sandbox/Sandbox.tsx", "utf8");
const sandboxBenchmarkSource = readFileSync("components/sandbox/SandboxBenchmark.tsx", "utf8");
const sandboxLiveSource = readFileSync("components/sandbox/SandboxLive.tsx", "utf8");
const headerSource = readFileSync("components/SiteHeader.tsx", "utf8");
const localRouteSource = readFileSync("app/local/page.tsx", "utf8");
const localLabSource = readFileSync("components/local/LocalLab.tsx", "utf8");

for (const label of ["Compare", "Generate", "Import"]) {
  assert.ok(sandboxSource.includes(`label: "${label}"`), `missing ${label} mode`);
}

assert.ok(
  sandboxLiveSource.includes('model.key === "openai_gpt_5_6_luna"'),
  "Generate should default to GPT 5.6 Luna",
);
assert.ok(
  sandboxBenchmarkSource.includes('const DEFAULT_MODEL_A = "openai_gpt_5_5_pro"') &&
    sandboxBenchmarkSource.includes('const DEFAULT_MODEL_B = "openai_gpt_5_6_sol"'),
  "Compare should default to GPT 5.5 Pro versus GPT 5.6 Sol Pro",
);

assert.ok(
  sandboxSource.includes('aria-label="Sandbox modes"') &&
    sandboxSource.includes("grid grid-cols-3 border-b border-border/70") &&
    sandboxSource.includes("-bottom-px left-0 h-0.5 w-1/3") &&
    sandboxSource.includes('aria-current={active ? "page" : undefined}'),
  "Sandbox modes should use flat navigation with a shared underline",
);
assert.ok(
  sandboxSource.includes("min-h-11") &&
    sandboxSource.includes('className="w-full sm:w-[336px]"'),
  "Sandbox modes should retain mobile-sized touch targets and a compact desktop width",
);
assert.ok(
  sandboxSource.includes('import("@/components/local/LocalLab")') &&
    sandboxSource.includes("<LocalLab />") &&
    !sandboxSource.includes("Model Comparison") &&
    !sandboxSource.includes("Live Generate"),
  "Import should reuse the Local Lab inside the three-mode Sandbox",
);
assert.ok(
  !headerSource.includes('<NavLink href="/local"') &&
    localRouteSource.includes('redirect("/sandbox?mode=import")'),
  "Local should leave the global header and remain as a compatibility redirect",
);
assert.ok(
  localLabSource.includes("Import a build") &&
    localLabSource.includes("Run the prompt anywhere, then import the result here.") &&
    localLabSource.includes("Adjust it to see how models respond when different qualities are emphasized."),
  "the imported workspace should use direct, location-independent copy",
);
assert.ok(
  localLabSource.includes('label="Copy for API"') &&
    localLabSource.includes('label="Copy for web"') &&
    localLabSource.includes("buildWebPrompt") &&
    localLabSource.includes("Optimized for the web harness") &&
    !localLabSource.includes("Running this through a chat UI") &&
    !localLabSource.includes("Return only the final voxel object as a JSON file/artifact attachment."),
  "Import should provide complete API and web prompts without a separate instruction layer",
);
assert.ok(
  localLabSource.includes("Import JSON") &&
    localLabSource.includes("Paste or drop a JSON file.") &&
    localLabSource.includes("async function loadJsonFile") &&
    localLabSource.includes("onDrop={(e) =>") &&
    localLabSource.includes("file.text()") &&
    localLabSource.includes("mb-prompt-scroll"),
  "Import should accept dropped JSON files through the existing input flow",
);

console.log("sandbox workspace UI checks passed");
