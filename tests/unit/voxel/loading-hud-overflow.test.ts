import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

async function main() {
  const { VoxelLoadingHud } = await import("../../../components/voxel/VoxelLoadingHud");
  const markup = renderToStaticMarkup(
    React.createElement(VoxelLoadingHud, {
      label: "Trying again…",
      elapsed: "1:56",
      retryReason: JSON.stringify({ issues: [{ message: "Required" }] }).repeat(200),
    }),
  );

  assert.match(markup, /aria-label="Why MineBench is trying again"/);
  assert.match(markup, /max-h-/);
  assert.match(markup, /overflow-y-auto/);

  console.log("voxel loading retry details stay within the viewer");
}

void main();
