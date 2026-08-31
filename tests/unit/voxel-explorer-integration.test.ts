import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const launcher = read("components/voxel/VoxelExplorerLauncher.tsx");
const viewerCard = read("components/voxel/VoxelViewerCard.tsx");
const leaderboard = read("components/leaderboard/ModelDetail.tsx");

assert.match(read("app/layout.tsx"), /<VoxelExplorerProvider>/);
assert.match(launcher, /Explore this build\?/);
assert.match(launcher, /Step inside at block scale with keyboard and mouse\./);
assert.match(launcher, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
assert.match(read("components/voxel/VoxelExplorer.tsx"), /onClick=\{exit\}[\s\S]*?>\s*Exit\s*</);
assert.match(viewerCard, /showBuildView && !explorerActive/);

for (const path of [
  "components/sandbox/SandboxBenchmark.tsx",
  "components/sandbox/SandboxLive.tsx",
  "components/local/LocalLab.tsx",
  "components/gallery/GalleryDetail.tsx",
  "components/gallery/GalleryYours.tsx",
]) {
  assert.match(read(path), /explorer=/, `${path} must offer Explorer`);
}

assert.match(leaderboard, /activeFullCachedBuild \? \(\s*<VoxelExplorerLaunchButton/);
assert.match(leaderboard, /event\.key !== "Escape" \|\| explorerActive/);
assert.doesNotMatch(read("components/arena/Arena.tsx"), /explorer=|VoxelExplorerLaunchButton/);
assert.doesNotMatch(read("components/lab/ProtectedBuildInspector.tsx"), /explorer=|VoxelExplorerLaunchButton/);
