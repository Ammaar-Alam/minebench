import { Prisma } from "@prisma/client";
import { confidenceFromRd, stabilityTier } from "@/lib/arena/rating";
import { resolveModelDisplayName } from "@/lib/ai/modelCatalog";
import { prisma } from "@/lib/prisma";
import { stealthVoteGoalProgress } from "@/lib/stealth/policy";

type AggregateRow = {
  variantId: string;
  promptId: string;
  promptText: string;
  opponentKey: string;
  opponentDisplayName: string;
  variantSide: "A" | "B";
  choice: "A" | "B" | "TIE" | "BOTH_BAD";
  votes: number | bigint | string;
};

export type StealthOutcomeSummary = {
  votes: number;
  decisiveVotes: number;
  wins: number;
  losses: number;
  draws: number;
  bothBad: number;
  averageScore: number | null;
};

export type StealthBreakdown = StealthOutcomeSummary & {
  id: string;
  label: string;
};

export type StealthBuildReportRow = {
  resultId: string | null;
  promptId: string;
  prompt: string;
  status: string;
  attempts: number;
  generationTimeMs: number;
  error: string | null;
  blockCount: number | null;
};

export type StealthVariantReport = {
  id: string;
  codename: string;
  source: string;
  status: string;
  generatedBuildCount: number;
  expectedBuildCount: number;
  cohortGeneratedAt: Date | null;
  releasedModelKey: string | null;
  rating: number;
  conservativeRating: number;
  ratingDeviation: number;
  confidence: number;
  stability: "Provisional" | "Established" | "Stable";
  estimatedFieldRank: number;
  estimatedFieldSize: number;
  targetDecisiveVotes: number | null;
  progress: number | null;
  pendingVotes: number;
  sideA: number;
  sideB: number;
  sideBalance: number | null;
  promptScoreSpread: number | null;
  hasEndpointCredential: boolean;
  outcomes: StealthOutcomeSummary;
  prompts: StealthBreakdown[];
  opponents: StealthBreakdown[];
  latestGenerationRun: {
    id: string;
    status: string;
    workflowRunId: string | null;
    completedBuildCount: number;
    expectedBuildCount: number;
    failedBuildCount: number;
    providerCallCount: number;
    retryCount: number;
    startedAt: Date;
    completedAt: Date | null;
  } | null;
  builds: StealthBuildReportRow[];
};

export type StealthExperimentReport = {
  id: string;
  slug: string;
  name: string;
  status: string;
  exportPolicy: string;
  targetDecisiveVotes: number | null;
  pauseAtGoal: boolean;
  agreementReference: string | null;
  startsAt: Date | null;
  endedAt: Date | null;
  retentionDeleteAt: Date | null;
  organization: { id: string; slug: string; name: string };
  variants: StealthVariantReport[];
};

function toNumber(value: number | bigint | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyOutcomes(): StealthOutcomeSummary {
  return {
    votes: 0,
    decisiveVotes: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    bothBad: 0,
    averageScore: null,
  };
}

function addOutcome(
  target: StealthOutcomeSummary,
  row: Pick<AggregateRow, "variantSide" | "choice">,
  count: number,
): void {
  target.votes += count;
  if (row.choice === "BOTH_BAD") {
    target.bothBad += count;
    return;
  }
  if (row.choice === "TIE") {
    target.draws += count;
    return;
  }
  target.decisiveVotes += count;
  const won =
    (row.variantSide === "A" && row.choice === "A") ||
    (row.variantSide === "B" && row.choice === "B");
  if (won) target.wins += count;
  else target.losses += count;
}

function finalizeOutcomes<T extends StealthOutcomeSummary>(summary: T): T {
  const scored = summary.wins + summary.losses + summary.draws;
  return {
    ...summary,
    averageScore: scored > 0 ? (summary.wins + summary.draws * 0.5) / scored : null,
  } as T;
}

function safeGenerationError(status: string, error: string | null): string | null {
  if (!error || status !== "FAILED") return null;
  return "Generation failed";
}

function appendBreakdown(
  map: Map<string, StealthBreakdown>,
  id: string,
  label: string,
  row: AggregateRow,
  count: number,
): void {
  const breakdown = map.get(id) ?? { id, label, ...emptyOutcomes() };
  addOutcome(breakdown, row, count);
  map.set(id, breakdown);
}

export async function getStealthExperimentReport(
  experimentId: string,
): Promise<StealthExperimentReport | null> {
  const experiment = await prisma.stealthExperiment.findUnique({
    where: { id: experimentId },
    include: {
      organization: { select: { id: true, slug: true, name: true } },
      variants: {
        orderBy: { codename: "asc" },
        include: {
          releasedModel: { select: { key: true } },
          credential: { select: { id: true } },
          model: {
            select: {
              builds: {
                orderBy: { prompt: { text: "asc" } },
                select: {
                  id: true,
                  promptId: true,
                  blockCount: true,
                  generationTimeMs: true,
                  prompt: { select: { id: true, text: true } },
                },
              },
            },
          },
          generationRuns: {
            orderBy: { startedAt: "desc" },
            take: 1,
            select: {
              id: true,
              status: true,
              workflowRunId: true,
              completedBuildCount: true,
              expectedBuildCount: true,
              failedBuildCount: true,
              providerCallCount: true,
              retryCount: true,
              startedAt: true,
              completedAt: true,
              results: {
                orderBy: { prompt: { text: "asc" } },
                select: {
                  id: true,
                  status: true,
                  attempts: true,
                  generationTimeMs: true,
                  error: true,
                  prompt: { select: { id: true, text: true } },
                  build: { select: { id: true, blockCount: true } },
                },
              },
            },
          },
          _count: { select: { voteJobs: { where: { processedAt: null } } } },
        },
      },
    },
  });
  if (!experiment) return null;
  const variantIds = experiment.variants.map((variant) => variant.id);
  const [aggregateRows, publicModels] = await Promise.all([
    variantIds.length === 0
      ? Promise.resolve([] as AggregateRow[])
      : prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
          SELECT
            variant.id AS "variantId",
            prompt.id AS "promptId",
            prompt.text AS "promptText",
            opponent.key AS "opponentKey",
            opponent."displayName" AS "opponentDisplayName",
            CASE WHEN matchup."modelAId" = variant."modelId" THEN 'A' ELSE 'B' END AS "variantSide",
            vote.choice AS choice,
            COUNT(*)::int AS votes
          FROM "Vote" vote
          INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
          INNER JOIN "StealthVariant" variant ON variant.id = matchup."stealthVariantId"
          INNER JOIN "Prompt" prompt ON prompt.id = matchup."promptId"
          INNER JOIN "Model" opponent ON opponent.id = CASE
            WHEN matchup."modelAId" = variant."modelId" THEN matchup."modelBId"
            ELSE matchup."modelAId"
          END
          WHERE variant.id IN (${Prisma.join(variantIds)})
          GROUP BY
            variant.id,
            prompt.id,
            prompt.text,
            opponent.key,
            opponent."displayName",
            "variantSide",
            vote.choice
        `),
    prisma.model.findMany({
      where: { enabled: true, stealthVariant: null },
      orderBy: { conservativeRating: "desc" },
      select: { conservativeRating: true },
    }),
  ]);

  const rowsByVariant = new Map<string, AggregateRow[]>();
  for (const row of aggregateRows) {
    const rows = rowsByVariant.get(row.variantId) ?? [];
    rows.push(row);
    rowsByVariant.set(row.variantId, rows);
  }

  return {
    id: experiment.id,
    slug: experiment.slug,
    name: experiment.name,
    status: experiment.status,
    exportPolicy: experiment.exportPolicy,
    targetDecisiveVotes: experiment.targetDecisiveVotes,
    pauseAtGoal: experiment.pauseAtGoal,
    agreementReference: experiment.agreementReference,
    startsAt: experiment.startsAt,
    endedAt: experiment.endedAt,
    retentionDeleteAt: experiment.retentionDeleteAt,
    organization: experiment.organization,
    variants: experiment.variants.map((variant) => {
      const outcomes = emptyOutcomes();
      const prompts = new Map<string, StealthBreakdown>();
      const opponents = new Map<string, StealthBreakdown>();
      let sideA = 0;
      let sideB = 0;
      for (const row of rowsByVariant.get(variant.id) ?? []) {
        const count = toNumber(row.votes);
        addOutcome(outcomes, row, count);
        appendBreakdown(prompts, row.promptId, row.promptText, row, count);
        appendBreakdown(
          opponents,
          row.opponentKey,
          resolveModelDisplayName(row.opponentKey, row.opponentDisplayName),
          row,
          count,
        );
        if (row.variantSide === "A") sideA += count;
        else sideB += count;
      }
      const finalizedPrompts = Array.from(prompts.values())
        .map(finalizeOutcomes)
        .sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label));
      const promptScores = finalizedPrompts
        .map((prompt) => prompt.averageScore)
        .filter((score): score is number => score != null);
      const totalSides = sideA + sideB;
      const finalizedOutcomes = finalizeOutcomes(outcomes);
      const rank = publicModels.filter(
        (model) => model.conservativeRating > variant.conservativeRating,
      ).length + 1;
      const latestGenerationRun = variant.generationRuns[0] ?? null;
      const latestGenerationResults = latestGenerationRun?.results ?? [];
      const buildsByPromptId = new Map<string, StealthBuildReportRow>(
        variant.model.builds.map((build) => [
          build.promptId,
          {
            resultId: null,
            promptId: build.prompt.id,
            prompt: build.prompt.text,
            status: "READY",
            attempts: 0,
            generationTimeMs: build.generationTimeMs,
            error: null,
            blockCount: build.blockCount,
          },
        ]),
      );
      for (const result of latestGenerationResults) {
        const persisted = buildsByPromptId.get(result.prompt.id);
        buildsByPromptId.set(result.prompt.id, {
          resultId: result.id,
          promptId: result.prompt.id,
          prompt: result.prompt.text,
          status: result.status,
          attempts: result.attempts,
          generationTimeMs: result.generationTimeMs || persisted?.generationTimeMs || 0,
          error: safeGenerationError(result.status, result.error),
          blockCount: result.build?.blockCount ?? persisted?.blockCount ?? null,
        });
      }
      const latestGenerationRunSummary = latestGenerationRun
        ? {
            id: latestGenerationRun.id,
            status: latestGenerationRun.status,
            workflowRunId: latestGenerationRun.workflowRunId,
            completedBuildCount: latestGenerationRun.completedBuildCount,
            expectedBuildCount: latestGenerationRun.expectedBuildCount,
            failedBuildCount: latestGenerationRun.failedBuildCount,
            providerCallCount: latestGenerationRun.providerCallCount,
            retryCount: latestGenerationRun.retryCount,
            startedAt: latestGenerationRun.startedAt,
            completedAt: latestGenerationRun.completedAt,
          }
        : null;
      return {
        id: variant.id,
        codename: variant.codename,
        source: variant.source,
        status: variant.status,
        generatedBuildCount: variant.generatedBuildCount,
        expectedBuildCount: variant.expectedBuildCount,
        cohortGeneratedAt: variant.cohortGeneratedAt,
        releasedModelKey: variant.releasedModel?.key ?? null,
        rating: variant.eloRating,
        conservativeRating: variant.conservativeRating,
        ratingDeviation: variant.glickoRd,
        confidence: confidenceFromRd(variant.glickoRd),
        stability: stabilityTier({
          decisiveVotes: finalizedOutcomes.decisiveVotes,
          promptCoverage:
            finalizedPrompts.filter((prompt) => prompt.decisiveVotes > 0).length /
            Math.max(1, variant.expectedBuildCount),
          rd: variant.glickoRd,
        }),
        estimatedFieldRank: rank,
        estimatedFieldSize: publicModels.length + 1,
        targetDecisiveVotes: experiment.targetDecisiveVotes,
        progress: stealthVoteGoalProgress(
          experiment.targetDecisiveVotes,
          finalizedOutcomes.decisiveVotes,
        ),
        pendingVotes: variant._count.voteJobs,
        sideA,
        sideB,
        sideBalance: totalSides > 0 ? Math.min(sideA, sideB) / totalSides : null,
        promptScoreSpread:
          promptScores.length > 1 ? Math.max(...promptScores) - Math.min(...promptScores) : null,
        hasEndpointCredential: variant.credential != null,
        outcomes: finalizedOutcomes,
        prompts: finalizedPrompts,
        opponents: Array.from(opponents.values())
          .map(finalizeOutcomes)
          .sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label)),
        latestGenerationRun: latestGenerationRunSummary,
        builds: Array.from(buildsByPromptId.values()).sort((a, b) =>
          a.prompt.localeCompare(b.prompt),
        ),
      };
    }),
  };
}

export type DeidentifiedStealthVote = {
  day: string;
  codename: string;
  prompt: string;
  opponent: string;
  variantSide: "A" | "B";
  choice: "WIN" | "LOSS" | "TIE" | "BOTH_BAD";
};

type ExportRow = Omit<DeidentifiedStealthVote, "choice"> & {
  rawChoice: "A" | "B" | "TIE" | "BOTH_BAD";
};

export async function getDeidentifiedStealthVotes(
  experimentId: string,
): Promise<DeidentifiedStealthVote[]> {
  const rows = await prisma.$queryRaw<ExportRow[]>(Prisma.sql`
    SELECT
      TO_CHAR(vote."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      variant.codename AS codename,
      prompt.text AS prompt,
      opponent."displayName" AS opponent,
      CASE WHEN matchup."modelAId" = variant."modelId" THEN 'A' ELSE 'B' END AS "variantSide",
      vote.choice AS "rawChoice"
    FROM "Vote" vote
    INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
    INNER JOIN "StealthVariant" variant ON variant.id = matchup."stealthVariantId"
    INNER JOIN "Prompt" prompt ON prompt.id = matchup."promptId"
    INNER JOIN "Model" opponent ON opponent.id = CASE
      WHEN matchup."modelAId" = variant."modelId" THEN matchup."modelBId"
      ELSE matchup."modelAId"
    END
    WHERE variant."experimentId" = ${experimentId}
    ORDER BY vote."createdAt" ASC
  `);
  return rows.map((row) => ({
    day: row.day,
    codename: row.codename,
    prompt: row.prompt,
    opponent: row.opponent,
    variantSide: row.variantSide,
    choice:
      row.rawChoice === "BOTH_BAD"
        ? "BOTH_BAD"
        : row.rawChoice === "TIE"
          ? "TIE"
          : row.rawChoice === row.variantSide
            ? "WIN"
            : "LOSS",
  }));
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function serializeDeidentifiedStealthVotes(rows: DeidentifiedStealthVote[]): string {
  const lines = ["date,codename,prompt,opponent,variant_side,outcome"];
  for (const row of rows) {
    lines.push(
      [row.day, row.codename, row.prompt, row.opponent, row.variantSide, row.choice]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
