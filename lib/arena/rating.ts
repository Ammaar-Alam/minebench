export const INITIAL_RATING = 1500;
export const INITIAL_RD = 350;
export const INITIAL_VOLATILITY = 0.06;
export const RD_FLOOR = 30;
export const RD_CEILING = 350;
export const CONSERVATIVE_SIGMAS = 2;
export const PROVISIONAL_DECISIVE_FLOOR = 80;
export const PROVISIONAL_PROMPT_COVERAGE_FLOOR = 0.8;
export const PROVISIONAL_RD_FLOOR = 90;
export const STABLE_DECISIVE_FLOOR = 200;
export const STABLE_PROMPT_COVERAGE_FLOOR = 0.9;
export const STABLE_RD_FLOOR = 60;

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
  const p = toGlickoScale(params.player);
  const o = toGlickoScale(params.opponent);

  const gPhi = g(o.phi);
  const e = expected(p.mu, o.mu, o.phi);
  const variance = 1 / (gPhi * gPhi * e * (1 - e));
  const delta = variance * gPhi * (params.score - e);
  const sigmaPrime = solveNewVolatility({
    phi: p.phi,
    sigma: p.sigma,
    delta,
    variance,
  });

  const phiStar = Math.sqrt(p.phi * p.phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / variance);
  const muPrime = p.mu + phiPrime * phiPrime * gPhi * (params.score - e);

  return fromGlickoScale({ mu: muPrime, phi: phiPrime, sigma: sigmaPrime });
}

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
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

export function conservativeScore(rating: number, rd: number): number {
  return rating - CONSERVATIVE_SIGMAS * rd;
}

export function confidenceFromRd(rd: number): number {
  const clamped = clampRd(rd);
  const fraction = (clamped - RD_FLOOR) / (RD_CEILING - RD_FLOOR);
  return Math.round((1 - fraction) * 100);
}

export function stabilityTier(params: {
  decisiveVotes: number;
  promptCoverage: number;
  rd: number;
}): StabilityTier {
  const { decisiveVotes, promptCoverage, rd } = params;
  if (
    decisiveVotes >= STABLE_DECISIVE_FLOOR &&
    promptCoverage >= STABLE_PROMPT_COVERAGE_FLOOR &&
    rd <= STABLE_RD_FLOOR
  ) {
    return "Stable";
  }
  if (
    decisiveVotes >= PROVISIONAL_DECISIVE_FLOOR &&
    promptCoverage >= PROVISIONAL_PROMPT_COVERAGE_FLOOR &&
    rd <= PROVISIONAL_RD_FLOOR
  ) {
    return "Established";
  }
  return "Provisional";
}

