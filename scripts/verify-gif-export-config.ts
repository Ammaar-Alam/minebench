import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_PATH = "components/sandbox/SandboxGifExportButton.tsx";
const sourceText = readFileSync(SOURCE_PATH, "utf8");
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

function readRenderProfiles(): Record<string, Array<{ width: number; height: number }>> {
  let profiles: Record<string, Array<{ width: number; height: number }>> | null = null;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "EXPORT_RENDER_PROFILES" &&
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
  assert.ok(profiles, "EXPORT_RENDER_PROFILES should be defined");
  return profiles;
}

const comparisonFrameCount = readNumericConst("COMPARISON_FRAME_COUNT");
const singleFrameCount = readNumericConst("SINGLE_FRAME_COUNT");
const comparisonFrameDelayMs = readNumericConst("COMPARISON_FRAME_DELAY_MS");
const singleFrameDelayMs = readNumericConst("SINGLE_FRAME_DELAY_MS");

assert.equal(comparisonFrameCount, 96);
assert.equal(singleFrameCount, 144);
assert.equal(comparisonFrameDelayMs, 40);
assert.equal(singleFrameDelayMs, 30);
assert.equal(comparisonFrameCount * comparisonFrameDelayMs, 3840);
assert.equal(singleFrameCount * singleFrameDelayMs, 4320);
assert.equal(readNumericConst("COMPARISON_PALETTE_SAMPLE_COUNT"), 12);
assert.equal(readNumericConst("COMPARISON_PALETTE_SAMPLE_LONG_EDGE"), 640);

const profiles = readRenderProfiles();
assert.deepEqual(profiles.wide?.[0], { width: 1440, height: 810 });
assert.deepEqual(profiles.vertical?.[0], { width: 810, height: 1440 });
assert.ok(
  sourceText.includes("frame / runtime.frameCount"),
  "GIF frame sampling should omit the duplicate endpoint for a seamless loop",
);

console.log("gif export config checks passed");
