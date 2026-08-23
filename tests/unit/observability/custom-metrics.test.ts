import assert from "node:assert/strict";
import {
  clientMetricBatchSchema,
  emitArenaBuildCustomMetrics,
  emitClientCustomMetrics,
  type CustomMetricEmitter,
} from "../../../lib/observability/customMetrics";
import { POST } from "../../../app/api/observability/client-metrics/route";

type Emission = {
  name: string;
  value: number;
  tags: Record<string, string>;
};

const validMatchupSample = {
  kind: "matchup" as const,
  mode: "random" as const,
  laneABlocks: "under-8k" as const,
  laneBBlocks: "150k-300k" as const,
  headersMs: 18.2,
  bodyMs: 4.1,
  totalMs: 22.3,
};

async function main() {
  const emissions: Emission[] = [];
  const emit: CustomMetricEmitter = (name, value, tags = {}) => {
    emissions.push({ name, value, tags });
  };

  emitArenaBuildCustomMetrics(
    {
      access: "blind",
      variant: "full",
      requestedFormat: "v4",
      servedFormat: "json",
      deliveryClass: "snapshot",
      source: "live",
      artifactOutcome: "miss",
      blockCount: 155_553,
      responseBytes: 2_000,
      transferBytes: 1_000,
      decodedBytes: 4_000,
      optimizedExpected: true,
      optimizedDelivered: false,
    },
    {
      token_validate: 1.234,
      artifact_resolve: 4.5,
      artifact_fetch: 80,
      total: 100,
    },
    200,
    emit,
  );

  assert.equal(
    emissions.filter((entry) => entry.name === "minebench.arena.build.stage_ms").length,
    4,
  );
  assert.equal(
    emissions.some((entry) => entry.name === "minebench.arena.build.optimized_miss"),
    true,
  );
  assert.equal(
    emissions.find(
      (entry) =>
        entry.name === "minebench.arena.build.stage_ms" &&
        entry.tags.stage === "token_validate",
    )?.value,
    1.23,
  );
  assert.equal(
    emissions.every((entry) => Object.keys(entry.tags).length <= 8),
    true,
  );

  const rejectedEmissions: Emission[] = [];
  emitArenaBuildCustomMetrics(
    {
      access: "blind",
      variant: "preview",
      requestedFormat: "v4",
      servedFormat: "json",
      deliveryClass: "unknown",
      source: "rejected",
      artifactOutcome: "invalid-token",
      blockCount: null,
      responseBytes: null,
      transferBytes: null,
      decodedBytes: null,
      optimizedExpected: true,
      optimizedDelivered: false,
    },
    { token_validate: 0.5, total: 1 },
    404,
    (name, value, tags = {}) => rejectedEmissions.push({ name, value, tags }),
  );
  assert.equal(
    rejectedEmissions.some((entry) => entry.name === "minebench.arena.build.optimized_miss"),
    false,
  );

  const errorEmissions: Emission[] = [];
  emitArenaBuildCustomMetrics(
    {
      access: "blind",
      variant: "full",
      requestedFormat: "v4",
      servedFormat: "json",
      deliveryClass: "snapshot",
      source: "live",
      artifactOutcome: "error",
      blockCount: 10_000,
      responseBytes: 2_000,
      transferBytes: 1_000,
      decodedBytes: 4_000,
      optimizedExpected: true,
      optimizedDelivered: false,
    },
    { artifact_fetch: 50, total: 100 },
    200,
    (name, value, tags = {}) => errorEmissions.push({ name, value, tags }),
  );
  assert.equal(
    errorEmissions.find((entry) => entry.name === "minebench.arena.build.request")?.tags.outcome,
    "error",
  );

  const parsed = clientMetricBatchSchema.safeParse({ samples: [validMatchupSample] });
  assert.equal(parsed.success, true);
  assert.equal(
    clientMetricBatchSchema.safeParse({
      samples: [{ ...validMatchupSample, buildId: "secret-build-id" }],
    }).success,
    false,
  );

  const clientEmissions: Emission[] = [];
  emitClientCustomMetrics(
    [
      validMatchupSample,
      {
        kind: "voxel",
        surface: "sandbox",
        variant: "full",
        strategy: "worker",
        cacheStatus: "miss",
        blockCountBucket: "150k-300k",
        renderedBlockCountBucket: "150k-300k",
        animated: false,
        queueMs: 1,
        atlasMs: 2,
        payloadMs: 300,
        groupMs: 30,
        meshMs: 330,
        firstRenderMs: 16,
        revealMs: 0,
        totalMs: 350,
      },
    ],
    (name, value, tags = {}) => clientEmissions.push({ name, value, tags }),
  );
  assert.equal(
    clientEmissions.some(
      (entry) =>
        entry.name === "minebench.voxel.stage_ms" && entry.tags.stage === "first_render",
    ),
    true,
  );
  assert.equal(
    clientEmissions.every((entry) => Object.keys(entry.tags).length <= 8),
    true,
  );

  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalNodeEnv = mutableEnv.NODE_ENV;
  mutableEnv.NODE_ENV = "production";
  try {
    const endpoint = "https://minebench.ai/api/observability/client-metrics";
    const crossOrigin = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.com" },
        body: JSON.stringify({ samples: [validMatchupSample] }),
      }),
    );
    assert.equal(crossOrigin.status, 403);

    const accepted = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://minebench.ai",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ samples: [validMatchupSample] }),
      }),
    );
    assert.equal(accepted.status, 204);

    const invalid = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://minebench.ai" },
        body: JSON.stringify({
          samples: [{ ...validMatchupSample, laneABlocks: "build-123" }],
        }),
      }),
    );
    assert.equal(invalid.status, 400);
  } finally {
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
  }

  console.log("custom metric contract checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
