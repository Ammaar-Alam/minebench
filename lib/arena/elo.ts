export const ELO_K = 16;
export const INITIAL_RATING = 1500;
export const BASELINE_RATING = 1500;

export type EloOutcome = "A_WIN" | "B_WIN" | "DRAW";

function expectedScore(ra: number, rb: number) {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

export function updateEloPair(params: {
  ratingA: number;
  ratingB: number;
  outcome: EloOutcome;
}): { newA: number; newB: number } {
  const ea = expectedScore(params.ratingA, params.ratingB);
  const eb = expectedScore(params.ratingB, params.ratingA);

  const scoreA = params.outcome === "A_WIN" ? 1 : params.outcome === "B_WIN" ? 0 : 0.5;
  const scoreB = params.outcome === "B_WIN" ? 1 : params.outcome === "A_WIN" ? 0 : 0.5;

  return {
    newA: params.ratingA + ELO_K * (scoreA - ea),
    newB: params.ratingB + ELO_K * (scoreB - eb),
  };
}

export function updateEloVsBaseline(rating: number, score: 0 | 0.5 | 1): number {
  const e = expectedScore(rating, BASELINE_RATING);
  return rating + ELO_K * (score - e);
}

