# MineBench Arena Ranking System (Implementation Guide)

This document explains how MineBench ranking works today in code, including the math, matchup selection, and what users see on the leaderboard.

- Source of truth: `app/api/arena/matchup/route.ts`, `app/api/arena/vote/route.ts`, `lib/arena/rating.ts`, `lib/arena/stats.ts`, `app/api/leaderboard/route.ts`.
- Companion policy: `docs/arena-ranking-validity-policy-v2.md`.

## Table of Contents

1. Why MineBench moved beyond pure Elo
2. Rating model and math
3. Vote handling and counters
4. Matchmaking lanes
5. Prompt selection math (for a chosen pair)
6. Worked example: GPT 5.2 Pro vs Gemini 3.1 Pro
7. Coverage and eligibility (why denominator matters)
8. Leaderboard metrics and formulas
9. What changed from the older Elo model

## 1) Why MineBench moved beyond pure Elo

MineBench originally used Elo-style point updates and largely random sampling. That is simple, but it has limits under finite traffic:

- Elo gives a point estimate but no uncertainty interval.
- Random sampling can under-cover important top-vs-top pairs and prompt subsets.
- `BOTH_BAD` is a quality-floor signal, not a clean pairwise-skill signal.

The current system keeps pairwise head-to-head updates, but adds:

- Glicko-style uncertainty (`RD`, volatility).
- Conservative rank score (`rating - 2 * RD`) for public ordering.
- Lane-based matchup scheduling to explicitly improve coverage quality.
- `BOTH_BAD` tracked as quality floor (not as skill loss).

## 2) Rating model and math

Implementation: `lib/arena/rating.ts`.

Each model state:

- `rating` (starts at 1500)
- `rd` (rating deviation, starts at 350)
- `volatility` (starts at 0.06)

Constants:

- `INITIAL_RATING = 1500`
- `GLICKO_SCALE = 173.7178`
- `RD_FLOOR = 30`, `RD_CEILING = 350`
- `TAU = 0.5` (named `VOLATILITY_TAU`)
- Conservative score sigmas = `2`

### 2.1 Scale conversion

For a player with `(r, RD)`:

- `mu = (r - 1500) / 173.7178`
- `phi = clamp(RD, 30, 350) / 173.7178`

Back-conversion:

- `r' = 1500 + mu' * 173.7178`
- `RD' = clamp(phi' * 173.7178, 30, 350)`

### 2.2 Expected score (Glicko form)

- `g(phi_j) = 1 / sqrt(1 + 3*phi_j^2 / pi^2)`
- `E = 1 / (1 + exp(-g(phi_j) * (mu - mu_j)))`

Outcome score `s`:

- win: `1`
- draw: `0.5`
- loss: `0`

### 2.3 Update terms

- `v = 1 / (g(phi_j)^2 * E * (1 - E))`
- `delta = v * g(phi_j) * (s - E)`

Volatility update `sigma'` is solved numerically (`solveNewVolatility`) using the standard Glicko-2 root finding approach.

Then:

- `phi* = sqrt(phi^2 + sigma'^2)`
- `phi' = 1 / sqrt(1/(phi*^2) + 1/v)`
- `mu' = mu + (phi'^2) * g(phi_j) * (s - E)`

Both models are updated symmetrically in `updateRatingPair`.

### 2.4 Public rank score

MineBench orders by conservative score:

- `rankScore = rating - 2 * RD`

This penalizes uncertain models and reduces lucky short-run spikes.

### 2.5 Confidence and stability

Confidence shown on leaderboard:

- `confidence = round((1 - (clampRd(RD) - 30) / (350 - 30)) * 100)`

Stability tier (`lib/arena/rating.ts`):

- `Stable`: decisive votes >= 200, prompt coverage >= 0.9, RD <= 60
- `Established`: decisive votes >= 80, prompt coverage >= 0.8, RD <= 90
- otherwise `Provisional`

## 3) Vote handling and counters

Implementation: `app/api/arena/vote/route.ts`, `lib/arena/voteMath.ts`.

Vote choices:

- `A`, `B`, `TIE`, `BOTH_BAD`

Behavior:

- `A/B/TIE`:
  - map to `A_WIN/B_WIN/DRAW`
  - update both models via `updateRatingPair`
  - recompute `conservativeRating`
  - increment `winCount/lossCount/drawCount`
- `BOTH_BAD`:
  - increment only `bothBadCount` on both models
  - do not change rating/RD/volatility

Aggregates:

- `decisiveLossCount = lossCount`
- `decisiveVotes = winCount + decisiveLossCount + drawCount`
- `totalVotes = decisiveVotes + bothBadCount`

## 4) Matchmaking lanes

Implementation: `app/api/arena/matchup/route.ts`.

Lane weights:

- Coverage: `0.4`
- Contender: `0.3`
- Uncertainty: `0.2`
- Exploration: `0.1`

System tries the sampled primary lane first, then falls back through the others if needed.

### 4.1 Coverage lane

Goal: improve weak coverage first.

- Anchor model: lowest prompt coverage, then lower `shownCount`.
- Opponent: lowest prior pair decisive votes, then smallest coverage gap.
- Prompt: chosen by lane-specific prompt score (see section 5).

### 4.2 Contender lane

Goal: stabilize ordering near top of leaderboard.

- Build contender band = top `K=8` by conservative score.
- First priority: adjacent pair deficits.
  - Vote deficit: `max(0, 12 - pairVotes)`
  - Prompt deficit: `max(0, 6 - pairPromptCountDistinct)`
- If an adjacent pair is below floor, it is preferred.
- Otherwise choose anchor/opponent by conservative-rating proximity with weighted buckets:
  - 70% nearest neighbor
  - 20% other contender by closest rating distance
  - 10% challenger from below band

### 4.3 Uncertainty lane

Goal: reduce uncertainty fastest.

- Anchor weight: `RD * (1 + (1 - promptCoverage))`
- Opponent score:
  - `prediction = expectedScore(anchorConservative, candidateConservative)`
  - `infoGain = 1 - 2*abs(prediction - 0.5)`
  - `coverageBonus = 1 / (pairVotes + 1)`
  - `score = infoGain + 0.25 * coverageBonus`
- Pick highest score.

### 4.4 Exploration lane

Goal: keep discovery and avoid overfitting top traffic.

- Prompt weight: inverse of total decisive votes for that prompt.
- Model weights: inverse `shownCount`.

### 4.5 New model onboarding behavior

When a new model is introduced, the system does prioritize calibration exposure, but it does not enforce equal total vote counts.

How it is prioritized:

- Coverage lane (40% of traffic) prefers the lowest prompt-coverage model first, then lower `shownCount`.
- Uncertainty lane (20%) weights anchors by `RD * (1 + (1 - promptCoverage))`; new models typically start with high RD and low coverage, so they are heavily favored.
- Exploration lane (10%) uses inverse `shownCount`, which also favors newly introduced models.

What it does not guarantee:

- No hard rule says a new model must exactly \"catch up\" to every other model’s total vote count.
- The target is improved calibration quality (coverage + uncertainty reduction), not strict equalized vote totals.

Important eligibility requirement:

- A model cannot appear in arena sampling until it has eligible builds (arena settings) on prompts that have at least two enabled models with builds.

## 5) Prompt selection math (for a chosen pair)

For a specific pair `(modelA, modelB)`, only shared prompt IDs are candidates.

Definitions per prompt `p`:

- `votesA = decisive votes for modelA on prompt p`
- `votesB = decisive votes for modelB on prompt p`
- `pairPromptVotes = decisive votes for this exact pair on prompt p`

Prompt score by lane:

- Coverage lane:
  - `score = votesA + votesB + 6 * pairPromptVotes`
- Contender lane:
  - `score = 10 * pairPromptVotes + 0.25 * abs(votesA - votesB)`
- Uncertainty lane:
  - `score = 3 * pairPromptVotes + abs(votesA - votesB) + (votesA + votesB)/2`
- Exploration lane:
  - `score = 2 * pairPromptVotes + (votesA + votesB)/2`

The prompt with the **lowest** score is selected.

Interpretation: lower score means less sampled / less balanced for the lane’s objective.

## 6) Worked example: GPT 5.2 Pro vs Gemini 3.1 Pro

Assume contender lane is active and these two are in (or near) adjacent top ranks.

### 6.1 Pair selection

Contender lane checks adjacent-pair floors first.

If this pair is short on:

- `pairVotes < 12`, or
- `distinctPairPrompts < 6`

then this pair gets prioritized before random contender pairing.

### 6.2 Prompt selection for this pair

Suppose candidate prompts have:

- `P1`: `pairPromptVotes=5`, `votesA=20`, `votesB=18`
- `P2`: `pairPromptVotes=2`, `votesA=11`, `votesB=10`

Contender lane scores:

- `P1 = 10*5 + 0.25*|20-18| = 50.5`
- `P2 = 10*2 + 0.25*|11-10| = 20.25`

`P2` is chosen because it is less covered for this exact pair.

This is why users may repeatedly see under-covered prompts for top rivals until floor targets are satisfied.

## 7) Coverage and eligibility (why denominator matters)

Coverage denominator must match the actual arena prompt universe.

MineBench now uses **arena-eligible prompts**, not all active prompts.

A prompt is eligible for arena coverage if:

- prompt is active, and
- at least two enabled non-baseline models have builds for arena settings:
  - `gridSize=256`, `palette=simple`, `mode=precise`

Relevant implementation:

- `lib/arena/eligibility.ts`
- `app/api/arena/prompts/route.ts`
- `lib/arena/stats.ts`

This resolves the historical mismatch where UI could show `covered / active` (for example `15/16`) while matchmaking only sampled 15 eligible prompts.

## 8) Leaderboard metrics and formulas

Implementation: `app/api/leaderboard/route.ts`, `lib/arena/stats.ts`, `components/leaderboard/Leaderboard.tsx`.

### 8.1 Core columns

- `Model`: display name/provider/stability chip
- `Rating`: conservative rank score (`rankScore`), with raw rating shown beneath
- `Confidence`: derived from RD
- `Coverage`: `coveredPrompts / activePrompts` plus percent
- `Consistency`: transformed spread score
- `Spread`: stddev of per-prompt average scores
- `Avg score`: mean per-prompt score over decisive comparisons
- `Record`: W/L/D
- `Votes`: total votes + both-bad count

### 8.2 Derived metrics

- `qualityFloorScore = max(0, 1 - bothBadCount / totalVotes)`
- `pairCoverageScore` (top band):
  - for each adjacent neighbor, compute `pairCompletion`
  - `pairCompletion = min(1, decisiveVotes/12, promptCount/6)`
  - score shown as average completion percent across immediate neighbors

### 8.3 Dispersion and consistency

`lib/arena/stats.ts` computes per-model prompt samples from decisive outcomes:

- per prompt average score in `[0,1]`
- `meanScore = average(promptAverages)`
- `scoreSpread = sqrt(VAR_POP(promptAverages))`
- `consistency = round((1 - min(0.5, scoreSpread)/0.5) * 100)`

Coverage floor for `coveredPrompts` uses at least 2 decisive votes per model-prompt.

## 9) What changed from older Elo behavior

Old behavior (historical):

- Elo-only public rating
- weaker coverage control
- `BOTH_BAD` affected loss/rating path

Current behavior:

- Glicko-style updates with uncertainty
- conservative public ordering
- lane-driven sampling for coverage/top-pair validity
- `BOTH_BAD` as quality-floor diagnostic only

## Implementation References

- Rating math: `lib/arena/rating.ts`
- Matchmaking: `app/api/arena/matchup/route.ts`
- Vote update transaction: `app/api/arena/vote/route.ts`
- Stats and coverage: `lib/arena/stats.ts`
- Eligible prompt universe: `lib/arena/eligibility.ts`
- Leaderboard API payload: `app/api/leaderboard/route.ts`
- Leaderboard UI: `components/leaderboard/Leaderboard.tsx`
