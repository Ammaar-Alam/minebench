import assert from "node:assert/strict";
import {
  artifactKindForDownloadFormat,
  chooseCustomBuildProviderCredential,
  customBuildArtifactMatchesCurrentBuild,
  customBuildError,
  serializeCustomBuildStatus,
} from "../../../lib/custom-builds/api";

function main() {
  const credential = chooseCustomBuildProviderCredential({
    modelProvider: "gemini",
    openRouterModelId: "google/gemini-3.5-flash",
    preferOpenRouter: true,
    providerKeys: {
      gemini: "google-key",
      openrouter: "openrouter-key",
    },
  });
  assert.deepEqual(credential, {
    provider: "openrouter",
    providerKey: "openrouter-key",
  });

  assert.deepEqual(
    chooseCustomBuildProviderCredential({
      modelProvider: "anthropic",
      openRouterModelId: "anthropic/claude-opus-4.8",
      forceOpenRouter: true,
      providerKeys: {
        anthropic: "anthropic-key",
        openrouter: "openrouter-key",
      },
    }),
    {
      provider: "openrouter",
      providerKey: "openrouter-key",
    },
  );

  assert.throws(
    () =>
      chooseCustomBuildProviderCredential({
        modelProvider: "anthropic",
        openRouterModelId: "anthropic/claude-opus-4.8",
        forceOpenRouter: true,
        providerKeys: {
          anthropic: "anthropic-key",
        },
      }),
    /missing_provider_key/,
  );

  assert.throws(
    () =>
      chooseCustomBuildProviderCredential({
        modelProvider: "gemini",
        providerKeys: {},
      }),
    /missing_provider_key/,
  );

  assert.equal(artifactKindForDownloadFormat("json"), "build_json");
  assert.equal(artifactKindForDownloadFormat("json.gz"), "build_json");
  assert.equal(artifactKindForDownloadFormat("preview-json"), "preview_json");
  assert.equal(artifactKindForDownloadFormat("glb"), "glb");
  assert.equal(artifactKindForDownloadFormat("schem"), "schem");
  assert.equal(artifactKindForDownloadFormat("../json"), null);
  assert.equal(
    customBuildArtifactMatchesCurrentBuild(
      { kind: "build_json", sourceBuildSha256: "a".repeat(64) },
      "a".repeat(64),
    ),
    true,
  );
  assert.equal(
    customBuildArtifactMatchesCurrentBuild(
      { kind: "preview_json", sourceBuildSha256: "b".repeat(64) },
      "a".repeat(64),
    ),
    false,
  );

  const response = customBuildError("artifact_not_ready", "GLB export has not finished yet.", 409);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");

  const status = serializeCustomBuildStatus({
    customBuild: {
      publicId: "cb_123456789012345678901234",
      status: "succeeded",
      currentStage: "complete",
      createdAt: new Date("2026-05-31T22:15:10.000Z"),
      startedAt: new Date("2026-05-31T22:15:14.000Z"),
      completedAt: new Date("2026-05-31T22:22:42.000Z"),
      promptText: "A compact tower",
      gridSize: 64,
      palette: "simple",
      modelKind: "catalog",
      modelKey: "gemini_3_5_flash",
      modelProvider: "gemini",
      modelId: "gemini-3.5-flash",
      modelDisplayName: "Gemini 3.5 Flash",
      blockCount: 256,
      generationTimeMs: 10_000,
      warnings: [],
      errorCode: null,
      errorMessage: null,
      errorRetryable: null,
      buildSha256: "a".repeat(64),
    },
    artifacts: [
      {
        kind: "build_json",
        format: "json.gz",
        contentType: "application/gzip",
        byteSize: 1234,
        compressedByteSize: 456,
        sha256: "a".repeat(64),
        sourceBuildSha256: "b".repeat(64),
      },
      {
        kind: "build_json",
        format: "json.gz",
        contentType: "application/gzip",
        byteSize: 1235,
        compressedByteSize: 457,
        sha256: "a".repeat(64),
        sourceBuildSha256: "a".repeat(64),
      },
    ],
    exportJobs: [
      { type: "export", status: "queued", payload: { format: "glb", sourceBuildSha256: "a".repeat(64) } },
      { type: "export", status: "queued", payload: { format: "stl", sourceBuildSha256: "b".repeat(64) } },
    ],
  });

  assert.equal(status.id, "cb_123456789012345678901234");
  assert.equal(status.prompt, "A compact tower");
  assert.equal(status.artifacts.length, 1);
  assert.equal(status.artifacts[0]?.downloadUrl, "/api/custom-builds/cb_123456789012345678901234/artifacts/json");
  assert.deepEqual(status.exports.glb, { status: "queued" });
  assert.deepEqual(status.exports.stl, { status: "not_requested" });

  console.log("custom build API helper checks passed");
}

main();
