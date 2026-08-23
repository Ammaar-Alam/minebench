export const INITIAL_RATING = 1500;
export const INITIAL_RD = 350;
export const INITIAL_VOLATILITY = 0.06;
export const RD_FLOOR = 10;
export const RD_CEILING = 350;
export const CONSERVATIVE_SIGMAS = 2;

export const BT_SCALE = 400 / Math.LN10; // 173.7177927613007
export const BT_EDGE_PRIOR_POINTS = 0.5;
export const BT_EDGE_PRIOR_TOTAL = 1.0;
export const BT_VARIANCE_FLOOR = 1e-6;
export const BT_MAX_ITERS = 600;
export const BT_CONVERGENCE_EPSILON = 1e-9;
export const BT_PSEUDOINVERSE_RIDGE = 1e-9;
export const Z_95 = 1.959963984540054;

export const PROVISIONAL_DECISIVE_FLOOR = 80;
export const PROVISIONAL_PROMPT_COVERAGE_FLOOR = 0.8;
export const PROVISIONAL_CI_CEILING = 35;
export const STABLE_DECISIVE_FLOOR = 200;
export const STABLE_PROMPT_COVERAGE_FLOOR = 0.9;
export const STABLE_CI_CEILING = 20;

export type PairOutcome = "A_WIN" | "B_WIN" | "DRAW";

export type RatingState = {
  rating: number;
  rd: number;
  volatility: number;
};

export type StabilityTier = "Provisional" | "Established" | "Stable";

export function thetaToRating(theta: number, centerTheta = 0): number {
  return INITIAL_RATING + (theta - centerTheta) * BT_SCALE;
}

export function ratingToTheta(rating: number): number {
  return (rating - INITIAL_RATING) / BT_SCALE;
}

export function varianceToStandardError(variance: number): number {
  return Math.sqrt(Math.max(BT_VARIANCE_FLOOR, variance)) * BT_SCALE;
}

export function confidenceInterval95(standardError: number): number {
  return Z_95 * standardError;
}

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export function conservativeScore(rating: number, _rd = 0): number {
  return rating;
}

export function confidenceFromCi(ci95: number): number {
  return Math.round(Math.max(10, Math.min(99, 100 - Math.min(90, ci95 * 0.85))));
}

export function confidenceFromRd(rd: number): number {
  return confidenceFromCi(rd);
}

export function stabilityTier(params: {
  decisiveVotes: number;
  promptCoverage: number;
  ci95?: number;
  rd?: number;
}): StabilityTier {
  const { decisiveVotes, promptCoverage } = params;
  const uncertainty = params.ci95 ?? params.rd ?? 100;
  if (
    decisiveVotes >= STABLE_DECISIVE_FLOOR &&
    promptCoverage >= STABLE_PROMPT_COVERAGE_FLOOR &&
    uncertainty <= STABLE_CI_CEILING
  ) {
    return "Stable";
  }
  if (
    decisiveVotes >= PROVISIONAL_DECISIVE_FLOOR &&
    promptCoverage >= PROVISIONAL_PROMPT_COVERAGE_FLOOR &&
    uncertainty <= PROVISIONAL_CI_CEILING
  ) {
    return "Established";
  }
  return "Provisional";
}

export function computeConfidenceAwareRanks<
  T extends { rating: number; standardError: number; displayName?: string; key?: string },
>(models: T[]): Array<T & { rank: number }> {
  const sorted = [...models].sort(
    (a, b) =>
      b.rating - a.rating ||
      (a.displayName ?? a.key ?? "").localeCompare(b.displayName ?? b.key ?? ""),
  );

  return sorted.map((model, i) => {
    let significantlyBetterCount = 0;
    for (let j = 0; j < i; j += 1) {
      const diff = sorted[j].rating - model.rating;
      const combinedSe = Math.hypot(sorted[j].standardError, model.standardError);
      if (diff > Z_95 * combinedSe) {
        significantlyBetterCount += 1;
      }
    }
    return {
      ...model,
      rank: significantlyBetterCount + 1,
    };
  });
}

export function updateRatingPair(params: {
  a: RatingState;
  b: RatingState;
  outcome: PairOutcome;
  kFactor?: number;
}): { a: RatingState; b: RatingState } {
  const scoreA = params.outcome === "A_WIN" ? 1 : params.outcome === "B_WIN" ? 0 : 0.5;
  const expectedA = expectedScore(params.a.rating, params.b.rating);
  const k = params.kFactor ?? 16;
  const delta = k * (scoreA - expectedA);

  return {
    a: {
      rating: params.a.rating + delta,
      rd: Math.max(RD_FLOOR, params.a.rd * 0.995),
      volatility: params.a.volatility,
    },
    b: {
      rating: params.b.rating - delta,
      rd: Math.max(RD_FLOOR, params.b.rd * 0.995),
      volatility: params.b.volatility,
    },
  };
}
