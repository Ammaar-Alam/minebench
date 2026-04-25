import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { ArenaBuildDeliveryClass, ArenaBuildLoadHints, ArenaMatchup } from "@/lib/arena/types";
import { weightedPick } from "@/lib/arena/sampling";
import { expectedScore } from "@/lib/arena/rating";
import {
  deriveArenaBuildLoadHints,
  getCachedPreparedArenaBuild,
  getPreparedArenaBuildMetadataUpdate,
  pickInitialBuild,
  prepareArenaBuild,
} from "@/lib/arena/buildArtifacts";
import { createArenaBuildSnapshotArtifactSignedUrl } from "@/lib/arena/buildSnapshotArtifacts";
import { createArenaBuildStreamArtifactSignedUrl } from "@/lib/arena/buildStream";
import { createArenaMatchupToken, hasArenaMatchupSigningSecret } from "@/lib/arena/matchupToken";
import { isArenaCapacityError } from "@/lib/arena/writeRetry";
import {
  getArenaMatchupSamplingStateWithMeta,
  persistArenaMatchupShown,
  recordArenaMatchupShown,
  type CoverageState,
  type EligibleModel,
  type EligiblePrompt,
} from "@/lib/arena/coverage";
import { ServerTiming } from "@/lib/serverTiming";
import { trackServerEventInBackground } from "@/lib/analytics.server";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";

const CONTENDER_BAND_SIZE = 8;
const ADJ_PAIR_VOTES_FLOOR = 12;
const ADJ_PAIR_PROMPTS_FLOOR = 6;
type Lane = "coverage" | "contender" | "uncertainty" | "exploration";
type BuildPayloadMode = "inline" | "shell" | "adaptive";

const LANE_WEIGHTS: Array<{ lane: Lane; weight: number }> = [
  { lane: "coverage", weight: 0.4 },
  { lane: "contender", weight: 0.3 },
  { lane: "uncertainty", weight: 0.2 },
  { lane: "exploration", weight: 0.1 },
];
const MATCHUP_SLOW_EVENT_MS = Number.parseInt(
  process.env.ARENA_MATCHUP_SLOW_EVENT_MS ?? "1500",
  10,
);
const MATCHUP_INLINE_MAX_BYTES = Number.parseInt(
  process.env.ARENA_MATCHUP_INLINE_MAX_BYTES ?? "0",
  10,
);
const MATCHUP_ARTIFACT_URL_WARMING_ENABLED =
  (process.env.ARENA_MATCHUP_ARTIFACT_URL_WARMING_ENABLED ?? "1").trim() !== "0";

type MatchupChoice = {
  lane: Lane;
  reason: string;
  prompt: EligiblePrompt;
  modelA: EligibleModel;
  modelB: EligibleModel;
};

function getOrSetSessionId(res: NextResponse, req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const existing = match?.[1];
  if (existing) return existing;
  const id = crypto.randomUUID();
  res.cookies.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

function parseBuildPayloadMode(value: string | null): BuildPayloadMode {
  if (value === "shell") return "shell";
  if (value === "adaptive") return "adaptive";
  return "inline";
}

function shouldInlineInAdaptiveMode(deliveryClass: ArenaBuildDeliveryClass): boolean {
  return deliveryClass === "inline";
}

function shouldInlineInitialInAdaptiveMode(hints: ArenaBuildLoadHints): boolean {
  if (!shouldInlineInAdaptiveMode(getInitialAdaptiveDeliveryClass(hints))) return false;
  if (!Number.isFinite(MATCHUP_INLINE_MAX_BYTES) || MATCHUP_INLINE_MAX_BYTES <= 0) return false;
  const estimatedBytes = hints.initialEstimatedBytes;
  return typeof estimatedBytes === "number" && estimatedBytes > 0 && estimatedBytes <= MATCHUP_INLINE_MAX_BYTES;
}

function getInitialAdaptiveDeliveryClass(hints: ArenaBuildLoadHints): ArenaBuildDeliveryClass {
  return hints.initialDeliveryClass ?? hints.deliveryClass;
}

async function prepareArenaBuildById(buildId: string) {
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    select: {
      id: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      voxelByteSize: true,
      voxelCompressedByteSize: true,
      voxelSha256: true,
      arenaSnapshotPreview: true,
      arenaSnapshotFull: true,
      voxelData: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      voxelStorageEncoding: true,
    },
  });
  return build ? prepareArenaBuild(build) : null;
}

function pickPersistedVariantBuild(
  fullBuild: unknown | null | undefined,
  previewBuild: unknown | null | undefined,
  variant: "full" | "preview",
): ArenaMatchup["a"]["build"] {
  // exact variant only, no partial-backfill promotion
  return (variant === "preview" ? previewBuild : fullBuild) as ArenaMatchup["a"]["build"];
}

function pickPersistedInitialBuild(
  hints: ArenaBuildLoadHints,
  fullBuild: unknown | null | undefined,
  previewBuild: unknown | null | undefined,
): ArenaMatchup["a"]["build"] {
  return pickPersistedVariantBuild(fullBuild, previewBuild, hints.initialVariant);
}

async function warmFullBuildArtifactUrl(
  buildId: string,
  checksum: string | null,
  hints: ArenaBuildLoadHints,
) {
  if (!checksum) return;
  if (hints.deliveryClass === "stream-artifact") {
    await createArenaBuildStreamArtifactSignedUrl(buildId, "full", checksum).catch(() => null);
    return;
  }
  if (hints.deliveryClass === "snapshot" || hints.deliveryClass === "inline") {
    await createArenaBuildSnapshotArtifactSignedUrl(buildId, "full", checksum).catch(() => null);
  }
}

function randomPick<T>(items: T[]): T | null {
  return items.length ? (items[Math.floor(Math.random() * items.length)] ?? null) : null;
}

function pairKey(modelIdA: string, modelIdB: string): string {
  return modelIdA < modelIdB ? `${modelIdA}|${modelIdB}` : `${modelIdB}|${modelIdA}`;
}

function modelPromptKey(modelId: string, promptId: string): string {
  return `${modelId}|${promptId}`;
}

function pairPromptKey(modelIdA: string, modelIdB: string, promptId: string): string {
  return `${pairKey(modelIdA, modelIdB)}|${promptId}`;
}

function getModelPromptVotes(coverage: CoverageState, modelId: string, promptId: string): number {
  return coverage.modelPromptDecisiveVotes.get(modelPromptKey(modelId, promptId)) ?? 0;
}

function getPairVotes(coverage: CoverageState, modelIdA: string, modelIdB: string): number {
  return coverage.pairDecisiveVotes.get(pairKey(modelIdA, modelIdB)) ?? 0;
}

function getPairPromptCount(coverage: CoverageState, modelIdA: string, modelIdB: string): number {
  return coverage.pairPromptCounts.get(pairKey(modelIdA, modelIdB)) ?? 0;
}

function getPairPromptVotes(
  coverage: CoverageState,
  modelIdA: string,
  modelIdB: string,
  promptId: string,
): number {
  return coverage.pairPromptDecisiveVotes.get(pairPromptKey(modelIdA, modelIdB, promptId)) ?? 0;
}

function chooseLane(): Lane {
  const choice = weightedPick(LANE_WEIGHTS, (lane) => lane.weight);
  return choice?.lane ?? "exploration";
}

function candidateLanes(primary: Lane): Lane[] {
  const fallback: Lane[] = ["coverage", "contender", "uncertainty", "exploration"];
  return [primary, ...fallback.filter((lane) => lane !== primary)];
}

function getCommonPromptIds(
  promptIdsByModelId: Map<string, Set<string>>,
  modelAId: string,
  modelBId: string,
  forcedPromptId?: string,
): string[] {
  if (forcedPromptId) {
    const hasA = promptIdsByModelId.get(modelAId)?.has(forcedPromptId) ?? false;
    const hasB = promptIdsByModelId.get(modelBId)?.has(forcedPromptId) ?? false;
    return hasA && hasB ? [forcedPromptId] : [];
  }

  const setA = promptIdsByModelId.get(modelAId);
  const setB = promptIdsByModelId.get(modelBId);
  if (!setA || !setB) return [];

  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  const result: string[] = [];
  for (const promptId of smaller) {
    if (larger.has(promptId)) result.push(promptId);
  }
  return result;
}

function choosePromptForPair(params: {
  promptById: Map<string, EligiblePrompt>;
  commonPromptIds: string[];
  coverage: CoverageState;
  modelAId: string;
  modelBId: string;
  lane: Lane;
}): EligiblePrompt | null {
  const { promptById, commonPromptIds, coverage, modelAId, modelBId, lane } = params;
  if (commonPromptIds.length === 0) return null;

  const scored = commonPromptIds
    .map((promptId) => {
      const prompt = promptById.get(promptId);
      if (!prompt) return null;

      const votesA = getModelPromptVotes(coverage, modelAId, promptId);
      const votesB = getModelPromptVotes(coverage, modelBId, promptId);
      const pairPromptVotes = getPairPromptVotes(coverage, modelAId, modelBId, promptId);

      let score = pairPromptVotes * 4 + votesA + votesB;
      if (lane === "coverage") {
        score = votesA + votesB + pairPromptVotes * 6;
      } else if (lane === "contender") {
        score = pairPromptVotes * 10 + Math.abs(votesA - votesB) * 0.25;
      } else if (lane === "uncertainty") {
        score = pairPromptVotes * 3 + Math.abs(votesA - votesB) + (votesA + votesB) / 2;
      } else if (lane === "exploration") {
        score = pairPromptVotes * 2 + (votesA + votesB) / 2;
      }

      return { prompt, score };
    })
    .filter((entry): entry is { prompt: EligiblePrompt; score: number } => entry != null)
    .sort((a, b) => a.score - b.score);

  return scored[0]?.prompt ?? null;
}

function chooseCoverageMatchup(params: {
  models: EligibleModel[];
  promptById: Map<string, EligiblePrompt>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { models, promptById, promptIdsByModelId, coverage, forcedPromptId } = params;
  if (models.length < 2) return null;

  const anchorCandidates = [...models].sort((a, b) => {
    const coverageA = coverage.promptCoverageByModelId.get(a.id) ?? 0;
    const coverageB = coverage.promptCoverageByModelId.get(b.id) ?? 0;
    if (coverageA !== coverageB) return coverageA - coverageB;
    if (a.shownCount !== b.shownCount) return a.shownCount - b.shownCount;
    return a.displayName.localeCompare(b.displayName);
  });

  const anchor = anchorCandidates[0];
  if (!anchor) return null;

  const opponents = models
    .filter((model) => model.id !== anchor.id)
    .map((candidate) => {
      const commonPromptIds = getCommonPromptIds(
        promptIdsByModelId,
        anchor.id,
        candidate.id,
        forcedPromptId,
      );
      if (commonPromptIds.length === 0) return null;
      const pairVotes = getPairVotes(coverage, anchor.id, candidate.id);
      const coverageGap = Math.abs(
        (coverage.promptCoverageByModelId.get(anchor.id) ?? 0) -
          (coverage.promptCoverageByModelId.get(candidate.id) ?? 0),
      );
      return {
        candidate,
        pairVotes,
        coverageGap,
        commonPromptIds,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        candidate: EligibleModel;
        pairVotes: number;
        coverageGap: number;
        commonPromptIds: string[];
      } => entry != null,
    )
    .sort((a, b) => a.pairVotes - b.pairVotes || a.coverageGap - b.coverageGap);

  const opponent = opponents[0];
  if (!opponent) return null;

  const prompt = choosePromptForPair({
    promptById,
    commonPromptIds: opponent.commonPromptIds,
    coverage,
    modelAId: anchor.id,
    modelBId: opponent.candidate.id,
    lane: "coverage",
  });
  if (!prompt) return null;

  return {
    lane: "coverage",
    reason: `anchor:${anchor.key}`,
    prompt,
    modelA: anchor,
    modelB: opponent.candidate,
  };
}

function chooseContenderMatchup(params: {
  models: EligibleModel[];
  promptById: Map<string, EligiblePrompt>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { models, promptById, promptIdsByModelId, coverage, forcedPromptId } = params;
  if (models.length < 2) return null;

  const ranked = [...models].sort((a, b) => b.conservativeRating - a.conservativeRating);
  const contenders = ranked.slice(0, CONTENDER_BAND_SIZE);
  const challengers = ranked.slice(CONTENDER_BAND_SIZE, CONTENDER_BAND_SIZE + 8);
  if (contenders.length < 2) return null;

  const adjacentDeficits = contenders
    .slice(0, Math.max(0, contenders.length - 1))
    .map((left, index) => {
      const right = contenders[index + 1];
      if (!right) return null;
      const pairVotes = getPairVotes(coverage, left.id, right.id);
      const pairPrompts = getPairPromptCount(coverage, left.id, right.id);
      const voteDeficit = Math.max(0, ADJ_PAIR_VOTES_FLOOR - pairVotes);
      const promptDeficit = Math.max(0, ADJ_PAIR_PROMPTS_FLOOR - pairPrompts);
      if (voteDeficit <= 0 && promptDeficit <= 0) return null;
      return {
        left,
        right,
        pairVotes,
        pairPrompts,
        voteDeficit,
        promptDeficit,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        left: EligibleModel;
        right: EligibleModel;
        pairVotes: number;
        pairPrompts: number;
        voteDeficit: number;
        promptDeficit: number;
      } => entry != null,
    )
    .sort(
      (a, b) =>
        b.promptDeficit - a.promptDeficit ||
        b.voteDeficit - a.voteDeficit ||
        a.pairPrompts - b.pairPrompts ||
        a.pairVotes - b.pairVotes,
    );

  const targetAdjacentPair = adjacentDeficits[0] ?? null;
  if (targetAdjacentPair) {
    const swap = Math.random() < 0.5;
    const anchor = swap ? targetAdjacentPair.right : targetAdjacentPair.left;
    const opponent = swap ? targetAdjacentPair.left : targetAdjacentPair.right;
    const commonPromptIds = getCommonPromptIds(
      promptIdsByModelId,
      anchor.id,
      opponent.id,
      forcedPromptId,
    );
    if (commonPromptIds.length > 0) {
      const prompt = choosePromptForPair({
        promptById,
        commonPromptIds,
        coverage,
        modelAId: anchor.id,
        modelBId: opponent.id,
        lane: "contender",
      });
      if (prompt) {
        return {
          lane: "contender",
          reason: `adjacent-floor:${anchor.key}|${opponent.key}`,
          prompt,
          modelA: anchor,
          modelB: opponent,
        };
      }
    }
  }

  const anchor = randomPick(contenders);
  if (!anchor) return null;

  const anchorIndex = contenders.findIndex((model) => model.id === anchor.id);
  const nearestCandidates = [
    contenders[anchorIndex - 1],
    contenders[anchorIndex + 1],
  ].filter((model): model is EligibleModel => model != null);

  const byRatingDistance = (pool: EligibleModel[]) =>
    [...pool]
      .filter((model) => model.id !== anchor.id)
      .sort(
        (a, b) =>
          Math.abs(a.conservativeRating - anchor.conservativeRating) -
          Math.abs(b.conservativeRating - anchor.conservativeRating),
      );

  const contenderCandidates = byRatingDistance(contenders);
  const challengerCandidates = byRatingDistance(challengers);

  const sample = Math.random();
  const buckets: EligibleModel[][] =
    sample < 0.7
      ? [nearestCandidates, contenderCandidates, challengerCandidates]
      : sample < 0.9
        ? [contenderCandidates, nearestCandidates, challengerCandidates]
        : [challengerCandidates, nearestCandidates, contenderCandidates];

  let opponent: EligibleModel | null = null;
  let commonPromptIds: string[] = [];

  for (const bucket of buckets) {
    for (const candidate of bucket) {
      if (!candidate || candidate.id === anchor.id) continue;
      const prompts = getCommonPromptIds(promptIdsByModelId, anchor.id, candidate.id, forcedPromptId);
      if (prompts.length === 0) continue;
      opponent = candidate;
      commonPromptIds = prompts;
      break;
    }
    if (opponent) break;
  }

  if (!opponent || commonPromptIds.length === 0) return null;

  const prompt = choosePromptForPair({
    promptById,
    commonPromptIds,
    coverage,
    modelAId: anchor.id,
    modelBId: opponent.id,
    lane: "contender",
  });
  if (!prompt) return null;

  return {
    lane: "contender",
    reason: `anchor:${anchor.key}`,
    prompt,
    modelA: anchor,
    modelB: opponent,
  };
}

function chooseUncertaintyMatchup(params: {
  models: EligibleModel[];
  promptById: Map<string, EligiblePrompt>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { models, promptById, promptIdsByModelId, coverage, forcedPromptId } = params;
  if (models.length < 2) return null;

  const anchor = weightedPick(models, (model) => {
    const promptCoverage = coverage.promptCoverageByModelId.get(model.id) ?? 0;
    return model.ratingDeviation * (1 + (1 - promptCoverage));
  });

  if (!anchor) return null;

  const candidates = models
    .filter((model) => model.id !== anchor.id)
    .map((candidate) => {
      const commonPromptIds = getCommonPromptIds(
        promptIdsByModelId,
        anchor.id,
        candidate.id,
        forcedPromptId,
      );
      if (commonPromptIds.length === 0) return null;

      const prediction = expectedScore(anchor.conservativeRating, candidate.conservativeRating);
      const infoGain = 1 - Math.abs(prediction - 0.5) * 2;
      const pairVotes = getPairVotes(coverage, anchor.id, candidate.id);
      const coverageBonus = 1 / (pairVotes + 1);

      return {
        candidate,
        commonPromptIds,
        score: infoGain + coverageBonus * 0.25,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        candidate: EligibleModel;
        commonPromptIds: string[];
        score: number;
      } => entry != null,
    )
    .sort((a, b) => b.score - a.score);

  const opponent = candidates[0];
  if (!opponent) return null;

  const prompt = choosePromptForPair({
    promptById,
    commonPromptIds: opponent.commonPromptIds,
    coverage,
    modelAId: anchor.id,
    modelBId: opponent.candidate.id,
    lane: "uncertainty",
  });
  if (!prompt) return null;

  return {
    lane: "uncertainty",
    reason: `anchor:${anchor.key}`,
    prompt,
    modelA: anchor,
    modelB: opponent.candidate,
  };
}

function chooseExplorationMatchup(params: {
  prompts: EligiblePrompt[];
  modelsById: Map<string, EligibleModel>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { prompts, modelsById, coverage, forcedPromptId } = params;
  if (prompts.length === 0) return null;

  const promptPool = forcedPromptId
    ? prompts.filter((prompt) => prompt.id === forcedPromptId)
    : prompts;
  if (promptPool.length === 0) return null;

  const prompt = weightedPick(promptPool, (candidate) => {
    const decisive = coverage.promptDecisiveTotals.get(candidate.id) ?? 0;
    return 1 / (decisive + 1);
  });
  if (!prompt) return null;

  const promptModels = prompt.modelIds
    .map((modelId) => modelsById.get(modelId) ?? null)
    .filter((model): model is EligibleModel => model != null);
  if (promptModels.length < 2) return null;

  const modelA = weightedPick(promptModels, (model) => 1 / (model.shownCount + 1));
  if (!modelA) return null;
  const remaining = promptModels.filter((model) => model.id !== modelA.id);
  const modelB = weightedPick(remaining, (model) => 1 / (model.shownCount + 1));
  if (!modelB) return null;

  return {
    lane: "exploration",
    reason: `prompt:${prompt.id}`,
    prompt,
    modelA,
    modelB,
  };
}

function pickMatchup(params: {
  prompts: EligiblePrompt[];
  modelsById: Map<string, EligibleModel>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const models = Array.from(params.modelsById.values());
  if (models.length < 2) return null;

  const promptById = new Map(params.prompts.map((prompt) => [prompt.id, prompt]));
  const primaryLane = chooseLane();

  for (const lane of candidateLanes(primaryLane)) {
    const input = {
      models,
      promptById,
      promptIdsByModelId: params.promptIdsByModelId,
      coverage: params.coverage,
      forcedPromptId: params.forcedPromptId,
    };

    const choice =
      lane === "coverage"
        ? chooseCoverageMatchup(input)
        : lane === "contender"
          ? chooseContenderMatchup(input)
          : lane === "uncertainty"
            ? chooseUncertaintyMatchup(input)
            : chooseExplorationMatchup({
                prompts: params.prompts,
                modelsById: params.modelsById,
                coverage: params.coverage,
                forcedPromptId: params.forcedPromptId,
              });

    if (choice) return choice;
  }

  return null;
}

export async function GET(req: Request) {
  const timing = new ServerTiming();
  const requestStartedAt = timing.start();
  let finalized = false;
  const finalizeHeaders = (headers?: HeadersInit) => {
    const nextHeaders = new Headers(headers);
    if (!finalized) {
      timing.end("total", requestStartedAt);
      finalized = true;
    }
    timing.apply(nextHeaders);
    return nextHeaders;
  };
  const respondJson = (body: unknown, init?: ResponseInit) =>
    NextResponse.json(body, {
      ...init,
      headers: finalizeHeaders(init?.headers),
    });

  const url = new URL(req.url);
  const payloadMode = parseBuildPayloadMode(url.searchParams.get("payload"));
  const requestedPromptId = url.searchParams.get("promptId") ?? undefined;
  if (!hasArenaMatchupSigningSecret()) {
    return respondJson(
      { error: "Arena matchup token signing is not configured." },
      { status: 503 },
    );
  }

  let sampling: Awaited<ReturnType<typeof getArenaMatchupSamplingStateWithMeta>>;
  try {
    sampling = await getArenaMatchupSamplingStateWithMeta();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load arena state";
    return respondJson(
      { error: message },
      {
        status: isArenaCapacityError(error) ? 503 : 500,
        headers: isArenaCapacityError(error) ? { "Retry-After": "1" } : undefined,
      },
    );
  }
  timing.add("eligibility", sampling.meta.eligibilityMs, sampling.meta.cacheStatus);
  timing.add("coverage", sampling.meta.coverageMs, sampling.meta.cacheStatus);

  const { prompts, modelsById, promptIdsByModelId, buildsByModelPromptKey, coverage } =
    sampling.state;
  if (prompts.length === 0) {
    return respondJson(
      { error: "No seeded prompts found. Seed curated prompts/builds first." },
      { status: 409 },
    );
  }

  const forcedPromptId = prompts.some((prompt) => prompt.id === requestedPromptId)
    ? requestedPromptId
    : undefined;
  const picked = pickMatchup({
    prompts,
    modelsById,
    promptIdsByModelId,
    coverage,
    forcedPromptId,
  });

  if (!picked) {
    return respondJson(
      { error: "Failed to sample matchup models" },
      { status: 500 },
    );
  }

  const swapSides = Math.random() < 0.5;
  const leftModel = swapSides ? picked.modelB : picked.modelA;
  const rightModel = swapSides ? picked.modelA : picked.modelB;

  const buildMetaStartedAt = performance.now();
  const buildA = buildsByModelPromptKey.get(modelPromptKey(leftModel.id, picked.prompt.id)) ?? null;
  const buildB =
    buildsByModelPromptKey.get(modelPromptKey(rightModel.id, picked.prompt.id)) ?? null;
  const buildMetaMs = performance.now() - buildMetaStartedAt;
  timing.add("build_meta", buildMetaMs);

  if (!buildA || !buildB) {
    return respondJson({ error: "Missing seeded build" }, { status: 500 });
  }

  const checksumA = buildA.voxelSha256?.trim() || null;
  const checksumB = buildB.voxelSha256?.trim() || null;
  const shellHintsA = deriveArenaBuildLoadHints(buildA);
  const shellHintsB = deriveArenaBuildLoadHints(buildB);
  const shouldProbeA = payloadMode === "adaptive" && shellHintsA.initialEstimatedBytes == null;
  const shouldProbeB = payloadMode === "adaptive" && shellHintsB.initialEstimatedBytes == null;
  // adaptive mode keeps huge builds out of the matchup response
  const shouldPrepareA =
    payloadMode === "inline" ||
    (payloadMode === "adaptive" && (shouldInlineInitialInAdaptiveMode(shellHintsA) || shouldProbeA));
  const shouldPrepareB =
    payloadMode === "inline" ||
    (payloadMode === "adaptive" && (shouldInlineInitialInAdaptiveMode(shellHintsB) || shouldProbeB));

  let preparedA: Awaited<ReturnType<typeof prepareArenaBuild>> | null = null;
  let preparedB: Awaited<ReturnType<typeof prepareArenaBuild>> | null = null;
  let persistedInitialBuildA: ArenaMatchup["a"]["build"] | null = null;
  let persistedInitialBuildB: ArenaMatchup["b"]["build"] | null = null;
  const prepareStartedAt = performance.now();
  if (shouldPrepareA || shouldPrepareB) {
    preparedA = shouldPrepareA ? getCachedPreparedArenaBuild(buildA.id, checksumA) : null;
    preparedB = shouldPrepareB ? getCachedPreparedArenaBuild(buildB.id, checksumB) : null;

    try {
      const [buildAForPrepare, buildBForPrepare] = await Promise.all([
        shouldPrepareA && !preparedA
          ? prisma.build.findUnique({
              where: { id: buildA.id },
	              select: {
	                id: true,
	                gridSize: true,
	                palette: true,
	                blockCount: true,
	                voxelByteSize: true,
	                voxelCompressedByteSize: true,
	                voxelSha256: true,
	                arenaSnapshotPreview: true,
	                arenaSnapshotFull: true,
	              },
	            })
          : Promise.resolve(null),
        shouldPrepareB && !preparedB
          ? prisma.build.findUnique({
              where: { id: buildB.id },
	              select: {
	                id: true,
	                gridSize: true,
	                palette: true,
	                blockCount: true,
	                voxelByteSize: true,
	                voxelCompressedByteSize: true,
	                voxelSha256: true,
	                arenaSnapshotPreview: true,
	                arenaSnapshotFull: true,
	              },
	            })
          : Promise.resolve(null),
      ]);

      if ((shouldPrepareA && !preparedA && !buildAForPrepare) || (shouldPrepareB && !preparedB && !buildBForPrepare)) {
        return respondJson({ error: "Missing seeded build payload" }, { status: 500 });
      }

      if (shouldPrepareA && !preparedA && buildAForPrepare) {
        persistedInitialBuildA = pickPersistedInitialBuild(
          shellHintsA,
          buildAForPrepare.arenaSnapshotFull,
          buildAForPrepare.arenaSnapshotPreview,
        );
      }
      if (shouldPrepareB && !preparedB && buildBForPrepare) {
        persistedInitialBuildB = pickPersistedInitialBuild(
          shellHintsB,
          buildBForPrepare.arenaSnapshotFull,
          buildBForPrepare.arenaSnapshotPreview,
        );
      }

      [preparedA, preparedB] = await Promise.all([
	        preparedA || persistedInitialBuildA
	          ? Promise.resolve(preparedA)
	          : buildAForPrepare
	            ? prepareArenaBuildById(buildA.id)
	            : Promise.resolve(null),
	        preparedB || persistedInitialBuildB
	          ? Promise.resolve(preparedB)
	          : buildBForPrepare
	            ? prepareArenaBuildById(buildB.id)
	            : Promise.resolve(null),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load build payload";
      return respondJson({ error: message }, { status: 500 });
    }
  }
  const prepareMs = performance.now() - prepareStartedAt;
  timing.add("prepare", prepareMs);
  const shouldInlineA =
    payloadMode === "inline" ||
    (payloadMode === "adaptive" && shouldInlineInitialInAdaptiveMode(preparedA?.hints ?? shellHintsA));
  const shouldInlineB =
    payloadMode === "inline" ||
    (payloadMode === "adaptive" && shouldInlineInitialInAdaptiveMode(preparedB?.hints ?? shellHintsB));

  const matchupId = createArenaMatchupToken({
    promptId: picked.prompt.id,
    modelAId: leftModel.id,
    modelBId: rightModel.id,
    buildAId: buildA.id,
    buildBId: buildB.id,
    samplingLane: picked.lane,
    samplingReason: picked.reason,
  });
  const txMs = 0;
  timing.add("tx", txMs);
  const preparedForPersistence = [preparedA, preparedB].filter(
    (value): value is NonNullable<typeof value> => Boolean(value),
  );
  if (preparedForPersistence.length > 0) {
    after(async () => {
      await Promise.all(
        preparedForPersistence.map((prepared) =>
          prisma.build
            .update({
              where: { id: prepared.buildId },
              data: getPreparedArenaBuildMetadataUpdate(prepared),
            })
            .catch(() => undefined),
        ),
      );
    });
  }

  if (MATCHUP_ARTIFACT_URL_WARMING_ENABLED) {
    // warm signing caches after the matchup is already ready
    after(async () => {
      await Promise.allSettled([
        warmFullBuildArtifactUrl(buildA.id, checksumA, preparedA?.hints ?? shellHintsA),
        warmFullBuildArtifactUrl(buildB.id, checksumB, preparedB?.hints ?? shellHintsB),
      ]);
    });
  }

  const body: ArenaMatchup = {
    id: matchupId,
    samplingLane: picked.lane,
    prompt: { id: picked.prompt.id, text: picked.prompt.text },
    a: {
      model: {
        key: leftModel.key,
        provider: leftModel.provider,
        displayName: leftModel.displayName,
        eloRating: leftModel.eloRating,
      },
      build:
        (preparedA && shouldInlineA
          ? pickInitialBuild(preparedA)
          : shouldInlineA
            ? persistedInitialBuildA
            : null) as ArenaMatchup["a"]["build"],
      buildRef: preparedA?.buildRef ?? {
        buildId: buildA.id,
        variant: "full",
        checksum: checksumA,
      },
      previewRef: preparedA?.previewRef ?? {
        buildId: buildA.id,
        variant: "preview",
        checksum: checksumA,
      },
      serverValidated: Boolean(preparedA || (shouldInlineA && persistedInitialBuildA)),
      buildLoadHints: preparedA?.hints ?? shellHintsA,
    },
    b: {
      model: {
        key: rightModel.key,
        provider: rightModel.provider,
        displayName: rightModel.displayName,
        eloRating: rightModel.eloRating,
      },
      build:
        (preparedB && shouldInlineB
          ? pickInitialBuild(preparedB)
          : shouldInlineB
            ? persistedInitialBuildB
            : null) as ArenaMatchup["b"]["build"],
      buildRef: preparedB?.buildRef ?? {
        buildId: buildB.id,
        variant: "full",
        checksum: checksumB,
      },
      previewRef: preparedB?.previewRef ?? {
        buildId: buildB.id,
        variant: "preview",
        checksum: checksumB,
      },
      serverValidated: Boolean(preparedB || (shouldInlineB && persistedInitialBuildB)),
      buildLoadHints: preparedB?.hints ?? shellHintsB,
    },
  };
  recordArenaMatchupShown([leftModel.id, rightModel.id]);
  after(() => {
    // db count follows the shown impression
    return persistArenaMatchupShown([leftModel.id, rightModel.id]).catch(() => undefined);
  });

  const totalMs = performance.now() - requestStartedAt;
  if (Number.isFinite(totalMs) && totalMs >= MATCHUP_SLOW_EVENT_MS) {
    trackServerEventInBackground("arena_matchup_slow", {
      ms: Math.round(totalMs),
      eligibilityMs: Math.round(sampling.meta.eligibilityMs),
      coverageMs: Math.round(sampling.meta.coverageMs),
      buildMetaMs: Math.round(buildMetaMs),
      prepareMs: Math.round(prepareMs),
      txMs: Math.round(txMs),
      cacheStatus: sampling.meta.cacheStatus,
      lane: picked.lane,
      payloadMode,
    });
  }

  const res = NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store",
      "x-arena-coverage-cache": sampling.meta.cacheStatus,
      "x-build-payload-mode": payloadMode,
      "x-build-prepare-ms": String(Math.round(prepareMs)),
      "x-build-initial-a": preparedA?.hints.initialVariant ?? shellHintsA.initialVariant,
      "x-build-initial-b": preparedB?.hints.initialVariant ?? shellHintsB.initialVariant,
      ...Object.fromEntries(finalizeHeaders()),
    },
  });
  getOrSetSessionId(res, req);
  return res;
}
