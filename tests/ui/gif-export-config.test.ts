import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { getSandboxGifExportPanelGrid } from "../../lib/sandbox/gifExportLayout";

const SOURCE_PATH = "components/sandbox/SandboxGifExportButton.tsx";
const sourceText = readFileSync(SOURCE_PATH, "utf8");
const benchmarkSourceText = readFileSync("components/sandbox/SandboxBenchmark.tsx", "utf8");
const viewerSourceText = readFileSync("components/voxel/VoxelViewer.tsx", "utf8");
const accountSourceText = readFileSync("app/account/page.tsx", "utf8");
const settingsSourceText = readFileSync("app/account/MediaExportSettings.tsx", "utf8");
const sourceFile = ts.createSourceFile(SOURCE_PATH, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function readNumericConst(name: string): number {
  let value: number | null = null;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      if (ts.isNumericLiteral(node.initializer)) {
        value = Number(node.initializer.text);
      } else if (
        ts.isPrefixUnaryExpression(node.initializer) &&
        node.initializer.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.initializer.operand)
      ) {
        value = -Number(node.initializer.operand.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (value === null) {
    throw new Error(`${name} should be a numeric const`);
  }
  return value;
}

function readRenderProfiles(
  name = "EXPORT_RENDER_PROFILES",
): Record<string, Array<{ width: number; height: number }>> {
  let profiles: Record<string, Array<{ width: number; height: number }>> | null = null;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const parsed: Record<string, Array<{ width: number; height: number }>> = {};
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
        if (!ts.isArrayLiteralExpression(property.initializer)) continue;
        parsed[property.name.text] = property.initializer.elements.map((element) => {
          assert.ok(ts.isObjectLiteralExpression(element), "render profile entries should be objects");
          const widthProperty = element.properties.find(
            (entry): entry is ts.PropertyAssignment =>
              ts.isPropertyAssignment(entry) &&
              ts.isIdentifier(entry.name) &&
              entry.name.text === "width",
          );
          const heightProperty = element.properties.find(
            (entry): entry is ts.PropertyAssignment =>
              ts.isPropertyAssignment(entry) &&
              ts.isIdentifier(entry.name) &&
              entry.name.text === "height",
          );
          assert.ok(widthProperty, "render profile width should be present");
          assert.ok(heightProperty, "render profile height should be present");
          assert.ok(ts.isNumericLiteral(widthProperty.initializer), "render profile width should be numeric");
          assert.ok(ts.isNumericLiteral(heightProperty.initializer), "render profile height should be numeric");
          return {
            width: Number(widthProperty.initializer.text),
            height: Number(heightProperty.initializer.text),
          };
        });
      }
      profiles = parsed;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  assert.ok(profiles, `${name} should be defined`);
  return profiles;
}

function readProfileArray(name: string): Array<{ width: number; height: number }> {
  let profiles: Array<{ width: number; height: number }> | null = null;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      const initializer = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (!ts.isArrayLiteralExpression(initializer)) return;
      profiles = initializer.elements.map((element) => {
        assert.ok(ts.isObjectLiteralExpression(element), "render profile entries should be objects");
        const values = Object.fromEntries(
          element.properties.flatMap((property) => {
            if (
              !ts.isPropertyAssignment(property) ||
              !ts.isIdentifier(property.name) ||
              !ts.isNumericLiteral(property.initializer)
            ) {
              return [];
            }
            return [[property.name.text, Number(property.initializer.text)]];
          }),
        );
        return { width: values.width ?? 0, height: values.height ?? 0 };
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  assert.ok(profiles, `${name} should be defined`);
  return profiles;
}

const comparisonFrameCount = readNumericConst("COMPARISON_FRAME_COUNT");
const singleFrameCount = readNumericConst("SINGLE_FRAME_COUNT");
const comparisonFrameDelayMs = readNumericConst("COMPARISON_FRAME_DELAY_MS");
const singleFrameDelayMs = readNumericConst("SINGLE_FRAME_DELAY_MS");
const creatorFrameRate = readNumericConst("CREATOR_FRAME_RATE");
const creatorFrameCount = readNumericConst("CREATOR_FRAME_COUNT");
const creatorDurationMs = readNumericConst("CREATOR_DURATION_MS");

assert.equal(comparisonFrameCount, 108);
assert.equal(singleFrameCount, 135);
assert.equal(comparisonFrameDelayMs, 40);
assert.equal(singleFrameDelayMs, 40);
assert.equal(comparisonFrameCount * comparisonFrameDelayMs, 4320);
assert.equal(singleFrameCount * singleFrameDelayMs, 5400);
assert.equal(creatorFrameRate, 30);
assert.equal(creatorFrameCount, 180);
assert.equal(creatorDurationMs, 6000);
assert.equal(creatorFrameCount / creatorFrameRate, creatorDurationMs / 1000);
assert.equal(readNumericConst("COMPARISON_PALETTE_SAMPLE_COUNT"), 12);
assert.equal(readNumericConst("COMPARISON_PALETTE_SAMPLE_LONG_EDGE"), 640);

const profiles = readRenderProfiles();
assert.deepEqual(profiles.wide?.[0], { width: 1440, height: 810 });
assert.deepEqual(profiles.vertical?.[0], { width: 810, height: 1440 });
const multiRowWideProfiles = readProfileArray("MULTI_ROW_WIDE_RENDER_PROFILES");
assert.deepEqual(multiRowWideProfiles[0], { width: 1440, height: 1080 });
for (const profile of multiRowWideProfiles) {
  const panelHeight = (profile.height - 107 - 22 - 16) / 2;
  assert.ok(panelHeight >= 220, "multi-row wide profiles should preserve usable panel height");
}
const creatorProfiles = readRenderProfiles("CREATOR_EXPORT_RENDER_PROFILES");
assert.deepEqual(creatorProfiles.single?.[0], { width: 1080, height: 1920 });
assert.deepEqual(creatorProfiles.wide?.[0], { width: 1920, height: 1080 });
assert.deepEqual(creatorProfiles.vertical?.[0], { width: 1080, height: 1920 });
assert.deepEqual(readProfileArray("CREATOR_MULTI_ROW_WIDE_RENDER_PROFILES")[0], {
  width: 1920,
  height: 1440,
});
assert.deepEqual(getSandboxGifExportPanelGrid(1, "single"), {
  columns: 1,
  rows: 1,
  rowColumns: [1],
});
assert.deepEqual(getSandboxGifExportPanelGrid(2, "wide"), {
  columns: 2,
  rows: 1,
  rowColumns: [2],
});
assert.deepEqual(getSandboxGifExportPanelGrid(2, "vertical"), {
  columns: 1,
  rows: 2,
  rowColumns: [1, 1],
});
assert.deepEqual(getSandboxGifExportPanelGrid(3, "wide"), {
  columns: 2,
  rows: 2,
  rowColumns: [2, 1],
});
assert.deepEqual(getSandboxGifExportPanelGrid(3, "vertical"), {
  columns: 2,
  rows: 2,
  rowColumns: [2, 1],
});
assert.deepEqual(getSandboxGifExportPanelGrid(4, "wide"), {
  columns: 2,
  rows: 2,
  rowColumns: [2, 2],
});
assert.deepEqual(getSandboxGifExportPanelGrid(4, "vertical"), {
  columns: 2,
  rows: 2,
  rowColumns: [2, 2],
});
assert.ok(
  sourceText.includes("frame / runtime.frameCount"),
  "GIF frame sampling should omit the duplicate endpoint for a seamless loop",
);
assert.ok(
  sourceText.includes("targets.length > 1"),
  "GIF export should treat every multi-model layout as a comparison",
);
assert.ok(
  !benchmarkSourceText.includes("autoRotate="),
  "comparison cards should use the shared viewer spin control",
);
assert.ok(
  !sourceText.includes('fit: "contain"'),
  "GIF panels should render at their own aspect instead of containing a viewer screenshot",
);
assert.ok(
  viewerSourceText.includes("retargetDistanceForAspect"),
  "GIF capture should preserve relative camera zoom when the export aspect changes",
);
assert.ok(
  viewerSourceText.includes("renderer.setPixelRatio(EXPORT_CAPTURE_PIXEL_RATIO)"),
  "GIF capture should supersample before compositing at the export size",
);
assert.ok(
  sourceText.includes("aria-describedby={iconOnly && !embedded ? tooltipId : undefined}") &&
    sourceText.includes("title={iconOnly && !embedded ? undefined : buttonTitle}"),
  "embedded icon exports should expose a native tooltip without referencing an omitted tooltip node",
);
assert.ok(
  sourceText.includes('await import("mediabunny")') &&
    sourceText.includes('codec: "avc"') &&
    sourceText.includes('new Quality("very-high")') &&
    sourceText.includes("frame / runtime.frameRate") &&
    sourceText.includes('type: "video/mp4"'),
  "Creator MP4 should be a lazily loaded, deterministic, very-high-quality H.264 export",
);
assert.ok(
  sourceText.includes('exportPreference.quality === "standard"') &&
    sourceText.includes("enforceSizeTarget && blob.size > GIF_TARGET_MAX_BYTES"),
  "only Standard GIFs should fall back to the sharing-size target",
);
assert.ok(
  accountSourceText.includes("<MediaExportSettings />") &&
    settingsSourceText.includes('value: "standard"') &&
    settingsSourceText.includes('value: "creator"') &&
    settingsSourceText.includes('value: "mp4"') &&
    settingsSourceText.includes('value: "gif"') &&
    settingsSourceText.includes("grid-rows-[1fr]") &&
    settingsSourceText.includes("motion-reduce:transition-none"),
  "Account should expose accessible Standard and Creator choices with a reduced-motion format reveal",
);

console.log("gif export config checks passed");
