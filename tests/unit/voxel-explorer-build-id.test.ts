import assert from "node:assert/strict";
import { parseExplorerBuildId } from "@/lib/voxel/explorerBuildId";

assert.deepEqual(parseExplorerBuildId("benchmark-build"), {
  source: "benchmark",
  id: "benchmark-build",
});
assert.deepEqual(parseExplorerBuildId("gallery:example-id"), {
  source: "gallery",
  id: "example-id",
});
assert.deepEqual(parseExplorerBuildId("gallery%3Aexample-id"), {
  source: "gallery",
  id: "example-id",
});
