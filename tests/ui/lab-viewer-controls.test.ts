import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const inspectorSource = readFileSync("components/lab/ProtectedBuildInspector.tsx", "utf8");

assert.ok(
  !inspectorSource.includes("autoRotate="),
  "protected build viewers should use the shared spin control",
);

console.log("lab viewer control checks passed");
