import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const inspectorSource = readFileSync("components/lab/ProtectedBuildInspector.tsx", "utf8");

assert.ok(
  !inspectorSource.includes("autoRotate="),
  "protected build viewers should use the shared spin control",
);
assert.match(inspectorSource, /\/api\/arena\/builds\/.*\/stream\?variant=full/);
assert.match(inspectorSource, /loadingProgress=/);

console.log("lab viewer control checks passed");
