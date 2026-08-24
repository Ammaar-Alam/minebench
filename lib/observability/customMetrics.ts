import { metric } from "@vercel/functions";
import { z } from "zod";
import type { ArenaBuildVariant } from "@/lib/arena/types";
import {
  getArenaBlockCountBucket,
  roundMetricMs,
} from "@/lib/observability/arenaMetrics";

const durationSchema = z.number().finite().nonnegative().nullable();
const blockCountBucketSchema = z.enum([
  "empty",
  "under-8k",
  "8k-50k",
  "50k-150k",
  "150k-300k",
  "300k-1m",
  "1m-plus",
  "unknown",
]);

const matchupMetricSchema = z
  .object({
    kind: z.literal("matchup"),
    mode: z.enum(["random", "forced"]),
    laneABlocks: blockCountBucketSchema,
    laneBBlocks: blockCountBucketSchema,
    headersMs: durationSchema,
    bodyMs: durationSchema,
    totalMs: durationSchema,
  })
  .strict();

const matchupStageMetricSchema = z
  .object({
    kind: z.literal("matchup-stage"),
    stage: z.enum(["preview_ready", "vote_ready"]),
    mode: z.enum(["random", "forced"]),
    laneABlocks: blockCountBucketSchema,
    laneBBlocks: blockCountBucketSchema,
    durationMs: durationSchema,
  })
  .strict();

const deliveryMetricSchema = z
  .object({
    kind: z.literal("delivery"),
    surface: z.enum(["arena", "sandbox", "leaderboard"]),
    purpose: z.enum(["visible", "prefetch"]),
    variant: z.enum(["preview", "full"]),
    transport: z.enum(["snapshot", "stream-artifact", "stream-live"]),
    requestedFormat: z.enum(["mbf1", "v4", "json", "ndjson"]),
    servedFormat: z.enum(["mesh-facts", "binary", "json", "ndjson"]),
    delivery_source: z.enum([
      "artifact",
      "live",
      "artifact-required",
      "artifact-redirect",
      "response-cache",
      "unknown",
    ]),
    blockCountBucket: blockCountBucketSchema,
    compressed: z.boolean(),
    optimized: z.boolean(),
    headersMs: durationSchema,
    bodyMs: durationSchema,
    inflateMs: durationSchema,
    decodeMs: durationSchema,
    totalMs: durationSchema,
    bodyBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

const voxelMetricSchema = z
  .object({
    kind: z.literal("voxel"),
    surface: z.enum(["arena", "sandbox", "leaderboard"]),
    variant: z.enum(["preview", "full"]),
    strategy: z.enum(["local", "worker", "worker-facts", "worker-fallback"]),
    cacheStatus: z.enum(["hit", "miss", "disabled", "not-used", "prewarm-hit"]),
    blockCountBucket: blockCountBucketSchema,
    renderedBlockCountBucket: blockCountBucketSchema,
    animated: z.boolean(),
    queueMs: durationSchema,
    atlasMs: durationSchema,
    payloadMs: durationSchema,
    groupMs: durationSchema,
    meshMs: durationSchema,
    firstRenderMs: durationSchema,
    revealMs: durationSchema,
    totalMs: durationSchema,
  })
  .strict();

export const clientMetricBatchSchema = z
  .object({
    samples: z
      .array(
        z.discriminatedUnion("kind", [
          matchupMetricSchema,
          matchupStageMetricSchema,
          deliveryMetricSchema,
          voxelMetricSchema,
        ]),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type ClientMetricSample = z.infer<
  typeof clientMetricBatchSchema
>["samples"][number];

export type ArenaBuildMetricStage =
  | "token_validate"
  | "artifact_resolve"
  | "artifact_fetch"
  | "inflate"
  | "identity_rewrite"
  | "deflate"
  | "body_ready"
  | "total";

export type ArenaBuildMetricObservation = {
  access: "blind" | "public";
  variant: ArenaBuildVariant;
  requestedFormat: "mbf1" | "v4" | "legacy";
  servedFormat: "mesh-facts" | "binary" | "json" | "ndjson" | "none";
  deliveryClass: string;
  source: string;
  artifactOutcome: string;
  blockCount: number | null;
  responseBytes: number | null;
  transferBytes: number | null;
  decodedBytes: number | null;
  optimizedExpected: boolean;
  optimizedDelivered: boolean;
};

export type CustomMetricEmitter = (
  name: string,
  value: number,
  tags?: Record<string, string>,
) => void;

function emitMetric(
  emit: CustomMetricEmitter,
  name: string,
  value: number | null | undefined,
  tags: Record<string, string>,
) {
  if (value == null || !Number.isFinite(value) || value < 0) return;
  try {
    emit(name, value, tags);
  } catch {
    // Metrics must never affect the request they describe
  }
}

function normalizeServerSource(value: string): string {
  if (value.startsWith("response-cache:")) return "response-cache";
  return [
    "unknown",
    "rejected",
    "metadata-miss",
    "artifact-redirect",
    "artifact",
    "artifact-redirect-miss",
    "stream-required",
    "live-prepare",
    "live",
  ].includes(value)
    ? value
    : "unknown";
}

function normalizeArtifactOutcome(value: string): string {
  return [
    "not-attempted",
    "invalid-token",
    "checksum-mismatch",
    "not-found",
    "private",
    "redirect",
    "hit",
    "miss",
    "error",
    "response-cache",
    "redirect-miss",
    "not-eligible",
    "prepare-error",
    "live",
  ].includes(value)
    ? value
    : "unknown";
}

function normalizeDeliveryClass(value: string): string {
  return ["inline", "snapshot", "stream-live", "stream-artifact"].includes(value)
    ? value
    : "unknown";
}

function getStatusClass(status: number): string {
  if (status < 300) return "success";
  if (status < 400) return "redirect";
  if (status < 500) return "client-error";
  return "server-error";
}

export function emitArenaBuildCustomMetrics(
  observation: ArenaBuildMetricObservation,
  stages: Partial<Record<ArenaBuildMetricStage, number>>,
  status: number,
  emit: CustomMetricEmitter = metric,
) {
  const tags = {
    access: observation.access,
    variant: observation.variant,
    format: `${observation.requestedFormat}-${observation.servedFormat}`,
    delivery_source: normalizeServerSource(observation.source),
    outcome: normalizeArtifactOutcome(observation.artifactOutcome),
    delivery_class: normalizeDeliveryClass(observation.deliveryClass),
    block_bucket: getArenaBlockCountBucket(observation.blockCount),
  };

  for (const [stage, value] of Object.entries(stages)) {
    emitMetric(emit, "minebench.arena.build.stage_ms", roundMetricMs(value), {
      ...tags,
      stage,
    });
  }

  for (const [kind, value] of [
    ["response", observation.responseBytes],
    ["transfer", observation.transferBytes],
    ["decoded", observation.decodedBytes],
  ] as const) {
    emitMetric(emit, "minebench.arena.build.bytes", value, { ...tags, kind });
  }

  emitMetric(emit, "minebench.arena.build.request", 1, {
    ...tags,
    status: getStatusClass(status),
  });

  if (status >= 200 && status < 400) {
    emitMetric(emit, "minebench.arena.build.delivery", 1, {
      ...tags,
      optimized: String(observation.optimizedDelivered),
    });
    if (observation.optimizedExpected && !observation.optimizedDelivered) {
      emitMetric(emit, "minebench.arena.build.optimized_miss", 1, tags);
    }
  }
}

function emitStages(
  emit: CustomMetricEmitter,
  name: string,
  tags: Record<string, string>,
  stages: Record<string, number | null>,
) {
  for (const [stage, value] of Object.entries(stages)) {
    emitMetric(emit, name, value, { ...tags, stage });
  }
}

export function emitClientCustomMetrics(
  samples: readonly ClientMetricSample[],
  emit: CustomMetricEmitter = metric,
) {
  for (const sample of samples) {
    if (sample.kind === "matchup") {
      const tags = {
        mode: sample.mode,
        lane_a_blocks: sample.laneABlocks,
        lane_b_blocks: sample.laneBBlocks,
      };
      emitStages(emit, "minebench.arena.matchup.stage_ms", tags, {
        headers: sample.headersMs,
        body: sample.bodyMs,
        total: sample.totalMs,
      });
      emitMetric(emit, "minebench.arena.matchup.complete", 1, tags);
      continue;
    }

    if (sample.kind === "matchup-stage") {
      const tags = {
        mode: sample.mode,
        stage: sample.stage,
        lane_a_blocks: sample.laneABlocks,
        lane_b_blocks: sample.laneBBlocks,
      };
      emitMetric(emit, "minebench.arena.matchup.stage_ms", sample.durationMs, tags);
      continue;
    }

    if (sample.kind === "delivery") {
      const tags = {
        surface: sample.surface,
        purpose: sample.purpose,
        variant: sample.variant,
        transport: sample.transport,
        format: `${sample.requestedFormat}-${sample.servedFormat}`,
        delivery_source: sample.delivery_source,
        block_bucket: sample.blockCountBucket,
        encoding: sample.compressed ? "gzip" : "identity",
      };
      emitStages(emit, "minebench.arena.delivery.stage_ms", tags, {
        headers: sample.headersMs,
        body: sample.bodyMs,
        inflate: sample.inflateMs,
        decode: sample.decodeMs,
        total: sample.totalMs,
      });
      emitMetric(emit, "minebench.arena.delivery.body_bytes", sample.bodyBytes, tags);
      emitMetric(emit, "minebench.arena.delivery.complete", 1, {
        ...tags,
        optimized: String(sample.optimized),
      });
      continue;
    }

    const tags = {
      surface: sample.surface,
      variant: sample.variant,
      strategy: sample.strategy,
      cache: sample.cacheStatus,
      block_bucket: sample.blockCountBucket,
      rendered_bucket: sample.renderedBlockCountBucket,
      animated: String(sample.animated),
    };
    emitStages(emit, "minebench.voxel.stage_ms", tags, {
      queue: sample.queueMs,
      atlas: sample.atlasMs,
      payload: sample.payloadMs,
      group: sample.groupMs,
      mesh: sample.meshMs,
      first_render: sample.firstRenderMs,
      reveal: sample.revealMs,
      total: sample.totalMs,
    });
    emitMetric(emit, "minebench.voxel.build", 1, tags);
  }
}
