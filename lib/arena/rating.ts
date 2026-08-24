export const INITIAL_RATING = 1500;
export const INITIAL_RD = 350;
export const INITIAL_VOLATILITY = 0.06;
export const RD_FLOOR = 30;
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
export const PROVISIONAL_RD_FLOOR = 90;
export const PROVISIONAL_CI_CEILING = 35;
export const STABLE_DECISIVE_FLOOR = 200;
export const STABLE_PROMPT_COVERAGE_FLOOR = 0.9;
export const STABLE_RD_FLOOR = 60;
export const STABLE_CI_CEILING = 20;

const GLICKO_SCALE = 173.7178;
const VOLATILITY_TAU = 0.5;
const SOLVER_EPSILON = 0.000001;

export type PairOutcome = "A_WIN" | "B_WIN" | "DRAW";

export type RatingState = {
  rating: number;
  rd: number;
  volatility: number;
};

export type StabilityTier = "Provisional" | "Established" | "Stable";

function clampRd(value: number): number {
  return Math.max(RD_FLOOR, Math.min(RD_CEILING, value));
}

function clampProbability(value: number): number {
  return Math.max(0.000001, Math.min(0.999999, value));
}

function toGlickoScale(state: RatingState) {
  return {
    mu: (state.rating - INITIAL_RATING) / GLICKO_SCALE,
    phi: clampRd(state.rd) / GLICKO_SCALE,
    sigma: Math.max(0.000001, state.volatility),
  };
}

function fromGlickoScale(params: { mu: number; phi: number; sigma: number }): RatingState {
  return {
    rating: INITIAL_RATING + params.mu * GLICKO_SCALE,
    rd: clampRd(params.phi * GLICKO_SCALE),
    volatility: Math.max(0.000001, params.sigma),
  };
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expected(mu: number, muOpponent: number, phiOpponent: number): number {
  return clampProbability(1 / (1 + Math.exp(-g(phiOpponent) * (mu - muOpponent))));
}

function solveNewVolatility(params: {
  phi: number;
  sigma: number;
  delta: number;
  variance: number;
}): number {
  const { phi, sigma, delta, variance } = params;
  const a = Math.log(sigma * sigma);

  const f = (x: number) => {
    const ex = Math.exp(x);
    const top = ex * (delta * delta - phi * phi - variance - ex);
    const bot = 2 * (phi * phi + variance + ex) ** 2;
    return top / bot - (x - a) / (VOLATILITY_TAU * VOLATILITY_TAU);
  };

  let A = a;
  let B: number;

  if (delta * delta > phi * phi + variance) {
    B = Math.log(delta * delta - phi * phi - variance);
  } else {
    let k = 1;
    while (f(a - k * VOLATILITY_TAU) < 0) {
      k += 1;
    }
    B = a - k * VOLATILITY_TAU;
  }

  let fA = f(A);
  let fB = f(B);

  while (Math.abs(B - A) > SOLVER_EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

function updateAgainstOne(params: {
  player: RatingState;
  opponent: RatingState;
  score: 0 | 0.5 | 1;
}): RatingState {
  const player = toGlickoScale(params.player);
  const opponent = toGlickoScale(params.opponent);
  const gPhi = g(opponent.phi);
  const expectedScore = expected(player.mu, opponent.mu, opponent.phi);
  const variance = 1 / (gPhi * gPhi * expectedScore * (1 - expectedScore));
  const delta = variance * gPhi * (params.score - expectedScore);
  const sigmaPrime = solveNewVolatility({
    phi: player.phi,
    sigma: player.sigma,
    delta,
    variance,
  });
  const phiStar = Math.sqrt(player.phi * player.phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / variance);
  const muPrime = player.mu + phiPrime * phiPrime * gPhi * (params.score - expectedScore);

  return fromGlickoScale({ mu: muPrime, phi: phiPrime, sigma: sigmaPrime });
}

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

export function conservativeScore(rating: number, rd: number): number {
  return rating - CONSERVATIVE_SIGMAS * rd;
}

export function confidenceFromCi(ci95: number): number {
  return Math.round(Math.max(10, Math.min(99, 100 - Math.min(90, ci95 * 0.85))));
}

export function confidenceFromRd(rd: number): number {
  const clamped = clampRd(rd);
  const fraction = (clamped - RD_FLOOR) / (RD_CEILING - RD_FLOOR);
  return Math.round((1 - fraction) * 100);
}

export function stabilityTier(params: {
  decisiveVotes: number;
  promptCoverage: number;
  ci95?: number;
  rd?: number;
}): StabilityTier {
  const { decisiveVotes, promptCoverage } = params;
  const uncertainty = params.ci95 ?? params.rd ?? Number.POSITIVE_INFINITY;
  const stableUncertainty = params.ci95 == null ? STABLE_RD_FLOOR : STABLE_CI_CEILING;
  const establishedUncertainty =
    params.ci95 == null ? PROVISIONAL_RD_FLOOR : PROVISIONAL_CI_CEILING;
  if (
    decisiveVotes >= STABLE_DECISIVE_FLOOR &&
    promptCoverage >= STABLE_PROMPT_COVERAGE_FLOOR &&
    uncertainty <= stableUncertainty
  ) {
    return "Stable";
  }
  if (
    decisiveVotes >= PROVISIONAL_DECISIVE_FLOOR &&
    promptCoverage >= PROVISIONAL_PROMPT_COVERAGE_FLOOR &&
    uncertainty <= establishedUncertainty
  ) {
    return "Established";
  }
  return "Provisional";
}

export function computeOrdinalRanks<
  T extends { rating: number; displayName?: string; key?: string },
>(models: T[]): Array<T & { rank: number }> {
  const sorted = [...models].sort(
    (a, b) =>
      b.rating - a.rating ||
      (a.displayName ?? a.key ?? "").localeCompare(b.displayName ?? b.key ?? ""),
  );

  return sorted.map((model, i) => ({
    ...model,
    rank: i + 1,
  }));
}

export function updateRatingPair(params: {
  a: RatingState;
  b: RatingState;
  outcome: PairOutcome;
}): { a: RatingState; b: RatingState } {
  const scoreA: 0 | 0.5 | 1 =
    params.outcome === "A_WIN" ? 1 : params.outcome === "B_WIN" ? 0 : 0.5;
  const scoreB: 0 | 0.5 | 1 =
    params.outcome === "B_WIN" ? 1 : params.outcome === "A_WIN" ? 0 : 0.5;

  return {
    a: updateAgainstOne({ player: params.a, opponent: params.b, score: scoreA }),
    b: updateAgainstOne({ player: params.b, opponent: params.a, score: scoreB }),
  };
}
