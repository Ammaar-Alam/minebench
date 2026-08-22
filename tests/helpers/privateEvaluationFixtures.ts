import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ArenaMatchupSamplingState } from "../../lib/arena/coverage";

export async function seedPrivateSamplingFixture(
  db: PrismaClient,
  options: { targetDecisiveVotes?: number | null; pauseAtGoal?: boolean } = {},
) {
  const suffix = randomUUID().replaceAll("-", "");
  const organization = await db.organization.create({
    data: { slug: `integration-${suffix}`, name: "Integration Organization" },
  });
  const experiment = await db.stealthExperiment.create({
    data: {
      organizationId: organization.id,
      slug: `evaluation-${suffix}`,
      name: "Integration Evaluation",
      status: "ACTIVE",
      targetDecisiveVotes: options.targetDecisiveVotes ?? null,
      pauseAtGoal: options.pauseAtGoal ?? true,
      startsAt: new Date(),
      checkpointSetFrozenAt: new Date(),
    },
  });
  const prompt = await db.prompt.create({
    data: { text: `Integration prompt ${suffix}`, active: true },
  });
  const publicModel = await db.model.create({
    data: {
      key: `public-${suffix}`,
      provider: "Public",
      modelId: `public-${suffix}`,
      displayName: "Public anchor",
      eloRating: 1550,
      conservativeRating: 1400,
      glickoRd: 80,
    },
  });
  const privateModel = await db.model.create({
    data: {
      key: `stealth/${experiment.id}/${suffix}`,
      provider: "Stealth",
      modelId: `private-${suffix}`,
      displayName: "Orchid",
    },
  });
  const variant = await db.stealthVariant.create({
    data: {
      experimentId: experiment.id,
      codename: "Orchid",
      status: "ACTIVE",
      modelId: privateModel.id,
      expectedBuildCount: 1,
      generatedBuildCount: 1,
      cohortGeneratedAt: new Date(),
    },
  });
  const privateBuild = await db.build.create({
    data: {
      promptId: prompt.id,
      modelId: privateModel.id,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      voxelData: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
      voxelSha256: "a".repeat(64),
      blockCount: 1,
      generationTimeMs: 1,
    },
  });

  const publicState: ArenaMatchupSamplingState = {
    prompts: [{ id: prompt.id, text: prompt.text, modelIds: [publicModel.id] }],
    modelsById: new Map([
      [
        publicModel.id,
        {
          id: publicModel.id,
          key: publicModel.key,
          provider: publicModel.provider,
          displayName: publicModel.displayName,
          eloRating: publicModel.eloRating,
          conservativeRating: publicModel.conservativeRating,
          ratingDeviation: publicModel.glickoRd,
          shownCount: publicModel.shownCount,
        },
      ],
    ]),
    promptIdsByModelId: new Map([[publicModel.id, new Set([prompt.id])]]),
    buildsByModelPromptKey: new Map(),
    coverage: {
      modelPromptDecisiveVotes: new Map(),
      pairDecisiveVotes: new Map(),
      pairPromptCounts: new Map(),
      pairPromptDecisiveVotes: new Map(),
      promptCoverageByModelId: new Map(),
      promptDecisiveTotals: new Map(),
      appliedVoteJobIds: new Set(),
    },
  };

  return {
    experiment,
    privateBuild,
    privateModel,
    publicModel,
    publicState,
    variant,
  };
}
