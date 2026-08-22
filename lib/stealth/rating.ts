import { conservativeScore, updateRatingPair } from "@/lib/arena/rating";
import type { VoteChoice } from "@/lib/arena/types";

export type StealthRatingState = {
  eloRating: number;
  glickoRd: number;
  glickoVolatility: number;
  conservativeRating: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
  bothBadCount: number;
};

export type PublicRatingAnchor = {
  eloRating: number;
  glickoRd: number;
  glickoVolatility: number;
};

export function applyStealthRatingVote(params: {
  variant: StealthRatingState;
  publicAnchor: PublicRatingAnchor;
  variantSide: "A" | "B";
  choice: VoteChoice;
}): StealthRatingState {
  const next = { ...params.variant };
  if (params.choice === "BOTH_BAD") {
    next.bothBadCount += 1;
    return next;
  }
  const outcome =
    params.choice === "A" ? "A_WIN" : params.choice === "B" ? "B_WIN" : "DRAW";
  const variantRating = {
    rating: params.variant.eloRating,
    rd: params.variant.glickoRd,
    volatility: params.variant.glickoVolatility,
  };
  const anchorRating = {
    rating: params.publicAnchor.eloRating,
    rd: params.publicAnchor.glickoRd,
    volatility: params.publicAnchor.glickoVolatility,
  };
  const updated = updateRatingPair({
    a: params.variantSide === "A" ? variantRating : anchorRating,
    b: params.variantSide === "B" ? variantRating : anchorRating,
    outcome,
  });
  const updatedVariant = params.variantSide === "A" ? updated.a : updated.b;
  next.eloRating = updatedVariant.rating;
  next.glickoRd = updatedVariant.rd;
  next.glickoVolatility = updatedVariant.volatility;
  next.conservativeRating = conservativeScore(updatedVariant.rating, updatedVariant.rd);

  if (params.choice === "TIE") next.drawCount += 1;
  else if (params.choice === params.variantSide) next.winCount += 1;
  else next.lossCount += 1;
  return next;
}
