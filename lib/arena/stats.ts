import { prisma } from "@/lib/prisma";

const MIN_PROMPTS_FOR_SPREAD = 3;
const MAX_SPREAD = 0.5;
const RECENT_FORM_WINDOW = 30;

type NormalizedChoice = "A" | "B" | "TIE" | "BOTH_BAD";

type PromptAccumulator = {
  scoreSum: number;
  voteCount: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
  bothBadCount: number;
  promptText?: string;
};

type OpponentAccumulator = {
  key: string;
  displayName: string;
  scoreSum: number;
  voteCount: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
  bothBadCount: number;
};

export type ScoreDispersion = {
  meanScore: number | null;
  scoreVariance: number | null;
  scoreSpread: number | null;
  consistency: number | null;
  sampledPrompts: number;
  sampledVotes: number;
};

export type ModelPromptBreakdown = {
  promptId: string;
  promptText: string;
  votes: number;
  averageScore: number;
  wins: number;
  losses: number;
  draws: number;
  bothBad: number;
};

export type ModelOpponentBreakdown = {
  key: string;
  displayName: string;
  votes: number;
  averageScore: number;
  wins: number;
  losses: number;
  draws: number;
  bothBad: number;
};

export type ModelDetailStats = {
  model: {
    key: string;
    provider: string;
    displayName: string;
    eloRating: number;
    shownCount: number;
    winCount: number;
    lossCount: number;
    drawCount: number;
    bothBadCount: number;
  };
  summary: ScoreDispersion & {
    totalVotes: number;
    decisiveVotes: number;
    winRate: number | null;
    recentForm: number | null;
    recentDelta: number | null;
  };
  prompts: ModelPromptBreakdown[];
  opponents: ModelOpponentBreakdown[];
};

function normalizeChoice(choice: string): NormalizedChoice | null {
  if (choice === "A" || choice === "B" || choice === "TIE" || choice === "BOTH_BAD") {
    return choice;
  }
  return null;
}

function scoresForChoice(choice: NormalizedChoice): { a: number; b: number } {
  if (choice === "A") return { a: 1, b: 0 };
  if (choice === "B") return { a: 0, b: 1 };
  if (choice === "TIE") return { a: 0.5, b: 0.5 };
  return { a: 0, b: 0 };
}

function createPromptAccumulator(promptText?: string): PromptAccumulator {
  return {
    scoreSum: 0,
    voteCount: 0,
    winCount: 0,
    lossCount: 0,
    drawCount: 0,
    bothBadCount: 0,
    promptText,
  };
}

function createOpponentAccumulator(key: string, displayName: string): OpponentAccumulator {
  return {
    key,
    displayName,
    scoreSum: 0,
    voteCount: 0,
    winCount: 0,
    lossCount: 0,
    drawCount: 0,
    bothBadCount: 0,
  };
}

function applyRecordCount(acc: PromptAccumulator | OpponentAccumulator, modelScore: number, choice: NormalizedChoice) {
  if (choice === "BOTH_BAD") {
    acc.bothBadCount += 1;
    return;
  }
  if (modelScore === 1) {
    acc.winCount += 1;
    return;
  }
  if (modelScore === 0) {
    acc.lossCount += 1;
    return;
  }
  acc.drawCount += 1;
}

function summarizeDispersion(promptAccumulators: Iterable<PromptAccumulator>): ScoreDispersion {
  const promptAverages: number[] = [];
  let sampledVotes = 0;

  for (const acc of promptAccumulators) {
    if (acc.voteCount <= 0) continue;
    promptAverages.push(acc.scoreSum / acc.voteCount);
    sampledVotes += acc.voteCount;
  }

  const sampledPrompts = promptAverages.length;
  if (sampledPrompts === 0) {
    return {
      meanScore: null,
      scoreVariance: null,
      scoreSpread: null,
      consistency: null,
      sampledPrompts: 0,
      sampledVotes: 0,
    };
  }

  const meanScore = promptAverages.reduce((sum, value) => sum + value, 0) / sampledPrompts;

  if (sampledPrompts < MIN_PROMPTS_FOR_SPREAD) {
    return {
      meanScore,
      scoreVariance: null,
      scoreSpread: null,
      consistency: null,
      sampledPrompts,
      sampledVotes,
    };
  }

  const variance =
    promptAverages.reduce((sum, value) => sum + (value - meanScore) ** 2, 0) / sampledPrompts;
  const spread = Math.sqrt(variance);
  const consistency = Math.round((1 - Math.min(MAX_SPREAD, spread) / MAX_SPREAD) * 100);

  return {
    meanScore,
    scoreVariance: variance,
    scoreSpread: spread,
    consistency,
    sampledPrompts,
    sampledVotes,
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function getLeaderboardDispersionByModelId(): Promise<Map<string, ScoreDispersion>> {
  const votes = await prisma.vote.findMany({
    select: {
      choice: true,
      matchup: {
        select: {
          promptId: true,
          modelAId: true,
          modelBId: true,
        },
      },
    },
  });

  const byModel = new Map<string, Map<string, PromptAccumulator>>();

  for (const vote of votes) {
    const choice = normalizeChoice(vote.choice);
    if (!choice) continue;

    const scores = scoresForChoice(choice);
    const promptId = vote.matchup.promptId;

    const modelAPrompts = byModel.get(vote.matchup.modelAId) ?? new Map<string, PromptAccumulator>();
    const accA = modelAPrompts.get(promptId) ?? createPromptAccumulator();
    accA.scoreSum += scores.a;
    accA.voteCount += 1;
    modelAPrompts.set(promptId, accA);
    byModel.set(vote.matchup.modelAId, modelAPrompts);

    const modelBPrompts = byModel.get(vote.matchup.modelBId) ?? new Map<string, PromptAccumulator>();
    const accB = modelBPrompts.get(promptId) ?? createPromptAccumulator();
    accB.scoreSum += scores.b;
    accB.voteCount += 1;
    modelBPrompts.set(promptId, accB);
    byModel.set(vote.matchup.modelBId, modelBPrompts);
  }

  const out = new Map<string, ScoreDispersion>();
  for (const [modelId, promptMap] of byModel.entries()) {
    out.set(modelId, summarizeDispersion(promptMap.values()));
  }
  return out;
}

export async function getModelDetailStats(modelKey: string): Promise<ModelDetailStats | null> {
  const model = await prisma.model.findFirst({
    where: { key: modelKey, enabled: true, isBaseline: false },
    select: {
      id: true,
      key: true,
      provider: true,
      displayName: true,
      eloRating: true,
      shownCount: true,
      winCount: true,
      lossCount: true,
      drawCount: true,
      bothBadCount: true,
    },
  });

  if (!model) return null;

  const votes = await prisma.vote.findMany({
    where: {
      matchup: {
        is: {
          OR: [{ modelAId: model.id }, { modelBId: model.id }],
        },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      choice: true,
      createdAt: true,
      matchup: {
        select: {
          promptId: true,
          prompt: {
            select: { text: true },
          },
          modelAId: true,
          modelBId: true,
          modelA: {
            select: { key: true, displayName: true },
          },
          modelB: {
            select: { key: true, displayName: true },
          },
        },
      },
    },
  });

  const promptMap = new Map<string, PromptAccumulator>();
  const opponentMap = new Map<string, OpponentAccumulator>();
  const voteScores: number[] = [];

  for (const vote of votes) {
    const choice = normalizeChoice(vote.choice);
    if (!choice) continue;

    const matchup = vote.matchup;
    const isModelA = matchup.modelAId === model.id;
    const scores = scoresForChoice(choice);
    const modelScore = isModelA ? scores.a : scores.b;
    const opponent = isModelA ? matchup.modelB : matchup.modelA;

    voteScores.push(modelScore);

    const promptAcc =
      promptMap.get(matchup.promptId) ?? createPromptAccumulator(matchup.prompt.text);
    promptAcc.scoreSum += modelScore;
    promptAcc.voteCount += 1;
    applyRecordCount(promptAcc, modelScore, choice);
    promptMap.set(matchup.promptId, promptAcc);

    const opponentAcc =
      opponentMap.get(opponent.key) ??
      createOpponentAccumulator(opponent.key, opponent.displayName);
    opponentAcc.scoreSum += modelScore;
    opponentAcc.voteCount += 1;
    applyRecordCount(opponentAcc, modelScore, choice);
    opponentMap.set(opponent.key, opponentAcc);
  }

  const dispersion = summarizeDispersion(promptMap.values());

  const prompts: ModelPromptBreakdown[] = Array.from(promptMap.entries())
    .map(([promptId, acc]) => ({
      promptId,
      promptText: acc.promptText ?? "Untitled prompt",
      votes: acc.voteCount,
      averageScore: acc.voteCount > 0 ? acc.scoreSum / acc.voteCount : 0,
      wins: acc.winCount,
      losses: acc.lossCount,
      draws: acc.drawCount,
      bothBad: acc.bothBadCount,
    }))
    .sort((a, b) => b.votes - a.votes || b.averageScore - a.averageScore);

  const opponents: ModelOpponentBreakdown[] = Array.from(opponentMap.values())
    .map((acc) => ({
      key: acc.key,
      displayName: acc.displayName,
      votes: acc.voteCount,
      averageScore: acc.voteCount > 0 ? acc.scoreSum / acc.voteCount : 0,
      wins: acc.winCount,
      losses: acc.lossCount,
      draws: acc.drawCount,
      bothBad: acc.bothBadCount,
    }))
    .sort((a, b) => b.votes - a.votes || b.averageScore - a.averageScore);

  const recentScores = voteScores.slice(0, RECENT_FORM_WINDOW);
  const priorScores = voteScores.slice(RECENT_FORM_WINDOW, RECENT_FORM_WINDOW * 2);
  const recentForm = average(recentScores);
  const priorForm = average(priorScores);

  const decisiveVotes = model.winCount + model.lossCount + model.drawCount;
  const totalVotes = decisiveVotes + model.bothBadCount;

  return {
    model: {
      key: model.key,
      provider: model.provider,
      displayName: model.displayName,
      eloRating: Number(model.eloRating),
      shownCount: model.shownCount,
      winCount: model.winCount,
      lossCount: model.lossCount,
      drawCount: model.drawCount,
      bothBadCount: model.bothBadCount,
    },
    summary: {
      ...dispersion,
      totalVotes,
      decisiveVotes,
      winRate: decisiveVotes > 0 ? model.winCount / decisiveVotes : null,
      recentForm,
      recentDelta:
        recentForm != null && priorForm != null ? recentForm - priorForm : null,
    },
    prompts,
    opponents,
  };
}
