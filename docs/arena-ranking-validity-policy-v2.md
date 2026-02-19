# MineBench Arena Ranking Validity Policy v2

Status: Draft  
Owner: Arena/Leaderboard  
Scope: Arena matchmaking, rating updates, leaderboard publication rules

## 1. Why This Policy Exists

Current Arena ranking is based on pairwise Elo with random prompt selection and exposure balancing by `shownCount`.

This is good for simplicity, but it has three validity limits under finite traffic:

- Sparse coverage of specific model-vs-model and model-vs-prompt combinations.
- High variance at the top when models are not repeatedly challenged by nearby rivals.
- Point ratings without uncertainty can overstate confidence.

Goal of v2: make rankings more objective and reproducible, closer to competitive rating systems where ranks mean something stable.

## 2. Current Baseline (As Implemented Today)

This policy is designed from the current behavior:

- Matchups choose one eligible prompt uniformly, then choose two distinct models with inverse-`shownCount` weighting.
- Elo uses `K=16`, initial `1500`, with A/B/TIE outcomes.
- `BOTH_BAD` currently applies a baseline-loss style update to each model.
- Leaderboard currently shows:
  - Rating
  - Consistency
  - Spread
  - Avg score
  - Record (W/L/D)
  - Votes and `bothBadCount`
- Model detail page currently shows:
  - Summary (including win rate, recent form, recent delta)
  - Prompt breakdown
  - Opponent breakdown
  - Build history access

## 3. Ranking Validity Objectives

v2 is successful when all of the following are true:

- Top ranks are robust to short-term sampling noise.
- Nearby top models are compared frequently enough to establish ordering confidence.
- Prompt coverage is balanced enough that no model is advantaged by prompt luck.
- Uncertainty is visible, and provisional models are clearly labeled.

## 4. Core Definitions

- Decisive vote: `A` or `B`.
- Non-decisive vote: `TIE` or `BOTH_BAD`.
- Exposure: one model appearing in one matchup.
- Prompt exposure: one model evaluated on one prompt in one matchup.
- Pair coverage: decisive votes between two models.
- Conservative score: `rating - 2 * RD` (lower confidence bound).
- Contender band: top `K` models by conservative score.

Default constants in this spec:

- `K = 8` (contender band size)
- Rolling fairness window `W = 2000` matchups
- Prompt floor `F_prompt = 2` decisive votes per model-prompt
- Top-band prompt target `T_prompt_top = 4` decisive votes per model-prompt
- Adjacent contender pair floor `F_adj_pair = 12` decisive votes across at least 6 prompts
- Left/right assignment must be 50/50 randomized

## 5. Rating Method

## 5.1 Primary system

Use Glicko-2 style rating state per model:

- `rating`
- `RD` (rating deviation / uncertainty)
- `volatility`

Use per-vote updates for `A`, `B`, `TIE` outcomes.

## 5.2 Public ordering

Rank models by conservative score (`rating - 2*RD`), not raw rating.

This prevents a newly lucky model from outranking a well-tested model with tighter confidence.

## 5.3 Provisional state

A model is provisional until all are true:

- `decisiveVotes >= 80`
- `promptCoverage >= 0.8` (defined in section 7)
- `RD <= 90`

Provisional models are visible but excluded from "official top-tier" claims.

## 6. Matchmaking Policy (Queue Mix)

Every new matchup request is assigned to one of four lanes.

Lane weights:

- Coverage lane: 40%
- Contender lane: 30%
- Uncertainty lane: 20%
- Exploration lane: 10%

This keeps fairness and discovery while forcing high-information comparisons.

## 6.1 Coverage lane (40%)

Purpose: equalize prompt and opponent exposure deficits.

Selection logic:

1. Compute coverage deficits for model-prompt and model-opponent pairs.
2. Pick the highest-deficit model as anchor.
3. Pick an opponent and prompt that maximizes joint deficit reduction.

Result: pushes the system toward equal opportunity across prompts and opponents.

## 6.2 Contender lane (30%)

Purpose: stabilize top ordering by frequent close-rival matches.

Anchor is sampled from contender band (top `K` by conservative score).

Opponent policy for anchor:

- 70% nearest neighbor by conservative rank (one above or below if available)
- 20% other contender with smallest rating distance
- 10% challenger from ranks `K+1` to `K+8`

Prompt policy:

- Prefer prompts with lowest coverage for that pair.
- Require prompt diversity: do not repeat same prompt for same pair more than 2 times in last 10 meetings.

## 6.3 Uncertainty lane (20%)

Purpose: reduce confidence intervals quickly.

Selection logic:

1. Anchor high-RD models (weighted by RD and low coverage).
2. Choose opponent maximizing expected information gain (predicted win probability near 0.5, with coverage bonus).

## 6.4 Exploration lane (10%)

Purpose: retain true discovery and avoid overfitting to current leaders.

Selection logic:

- Weighted random over eligible models with inverse exposure weighting.
- Prompt chosen from under-covered set first, then uniform random fallback.

## 7. Coverage Guarantees and What "Equal" Means

## 7.1 Model exposure fairness

Within rolling window `W`, each enabled model should have exposure within:

- Target: `2W / M`
- Tolerance: +/-12%

If outside tolerance, Coverage lane priority increases automatically for that model.

## 7.2 Prompt fairness per model

For each model, define prompt coverage ratio:

- `promptCoverage = (# prompts with >= F_prompt decisive votes) / (# active prompts)`

Expected behavior:

- All models trend toward similar promptCoverage.
- Top-band models trend toward `T_prompt_top`.

Important: exact equality at all times is not realistic under live traffic.  
v2 guarantees bounded imbalance over windows, not perfect instantaneous equality.

## 7.3 Pair coverage at the top

For adjacent contender pairs:

- At least `F_adj_pair` decisive votes
- Across at least 6 distinct prompts

Until this floor is met, contender lane over-samples that pair.

## 8. Vote Handling Rules

## 8.1 Decisive votes

- `A` / `B`: normal rating updates.

## 8.2 Ties

- `TIE`: 0.5 outcome for both models.

## 8.3 BOTH_BAD

`BOTH_BAD` should no longer directly change pairwise skill rating.

Instead:

- Track `bothBadRate = bothBadCount / totalVotes`.
- Track `qualityFloorScore = 1 - bothBadRate`.
- Use this as a leaderboard quality diagnostic and as a trigger for targeted quality checks.

Reason: `BOTH_BAD` is a quality-floor signal, not a reliable pairwise skill discriminator.

## 9. Leaderboard and Detail Stats Policy

## 9.1 Keep current visible metrics

Keep existing metrics already shown:

- Rating
- Consistency
- Spread
- Avg score
- Record
- Votes and both-bad count
- Model detail: summary, prompt breakdown, opponent breakdown, build history

## 9.2 Add required validity metrics

Leaderboard adds:

- `RD` (uncertainty)
- Conservative score (`rating - 2*RD`)
- Stability badge: `Provisional`, `Established`, `Stable`
- Prompt coverage percentage
- Pair coverage score (top-band relevant)

Model detail page adds:

- Coverage heatmap (prompt x opponent deficits)
- Neighbor challenge record (vs immediate rank neighbors)
- Quality floor score and both-bad trend
- Confidence history (rating and RD over time)

## 9.3 Locked UX Presentation

The main leaderboard UX is locked to this format:

- Keep current columns and interaction pattern.
- Replace the meaning of the existing `Rating` column with confidence-adjusted rank score.
- Do not add a second competing rating column.
- In each rating cell:
  - Primary value: conservative rank score (`rating - 2*RD`)
  - Secondary micro-text: raw rating
- Add two new visible leaderboard columns:
  - `Confidence` (derived from RD)
  - `Coverage` (prompt coverage)
- Show `Stability` as a compact badge in the model cell, not a standalone column.
- Keep advanced metrics (pair coverage details, calibration diagnostics) in model detail/tooltips.

## 10. Publication Rules

To label the leaderboard "officially stable":

- Top-10 median `RD <= 75`
- Top-10 adjacent pair coverage floor satisfied for >=80% of adjacent pairs
- Top-10 mean promptCoverage >= 0.9

If not met, show status as "calibrating" and keep ranking visible with caveat.

## 11. Anti-Bias and Integrity Controls

- Keep model identities hidden pre-vote.
- Randomize A/B placement 50/50 after pair selection.
- Prevent same user session from seeing same model pair and prompt too frequently.
- Apply bot and duplicate-vote safeguards as currently practiced.

## 12. Rollout Plan

Phase 1: Instrument only

- Compute coverage deficits, RD, conservative score in shadow mode.
- No ranking behavior changes yet.

Phase 2: Matchmaking lanes

- Turn on lane scheduler.
- Keep existing public ranking label but add calibration diagnostics.

Phase 3: Rating migration

- Move official ordering to conservative score.
- Keep legacy Elo as secondary field for continuity during transition.

Phase 4: Governance

- Weekly validity report:
  - Coverage fairness
  - Pair completeness
  - Confidence stability
  - Top-rank churn vs confidence bands

## 13. FAQ

Q: Does this ensure every model sees every prompt equally?  
A: It ensures near-equal coverage over time with explicit deficit correction and tolerance bounds. It does not guarantee perfect equality at every moment.

Q: Will top models face close rivals more often?  
A: Yes. Contender lane enforces nearest-neighbor and adjacent-rank comparisons as the default top-band behavior.

Q: Is pure randomness still present?  
A: Yes, via exploration lane. v2 keeps randomness for discovery but no longer relies on randomness alone for validity.
