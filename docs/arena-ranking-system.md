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

## 1) Why MineBench uses Global Bradley-Terry Ratings

MineBench uses a **global Bradley-Terry maximum likelihood estimator** with regularized Fisher information covariance estimation for leaderboard rankings:

- Each model checkpoint has a fixed underlying capability (unlike human chess players whose skill evolves over time).
- Sequential Glicko-2 updates are order-dependent and penalize models artificially through conservative rank scoring (`rating - 2 * RD`).
- Global Bradley-Terry fits all eligible public pairwise outcomes jointly, yielding point estimates on a standard Elo scale (centered at 1500) alongside 95% Confidence Intervals ($\text{CI}_{95} = 1.95996 \times SE$).
- Models are sorted by point estimate into unique ordinal ranks; 95% confidence intervals show uncertainty without collapsing ranks.
- `BOTH_BAD` is excluded from pairwise skill estimation and tracked separately as a quality floor metric.

## 2) Rating model and math

Implementation: `lib/arena/rating.ts`, `lib/arena/stats.ts`.

### 2.1 Bradley-Terry Formulation

Under the Bradley-Terry model, the probability that model $A$ (with latent capability $\theta_A$) beats model $B$ (with latent capability $\theta_B$) is:

$$P(A > B) = \frac{e^{\theta_A}}{e^{\theta_A} + e^{\theta_B}} = \frac{1}{1 + e^{-(\theta_A - \theta_B)}}$$

Let $\pi_i = e^{\theta_i}$ be the latent strength of model $i$. Given observed pairwise wins $W_{ij}$ and total comparisons $N_{ij}$ between models $i$ and $j$, we apply a symmetric edge prior ($W_{ij} += 0.5$, $N_{ij} += 1.0$) to ensure connected component convergence and prevent infinite divergence for zero-loss or zero-win models.

The maximum likelihood parameters $\pi_i$ are solved iteratively:

$$\pi_i^{(t+1)} = \frac{W_i}{\sum_{j \neq i} \frac{N_{ij}}{\pi_i^{(t)} + \pi_j^{(t)}}}$$

### 2.2 Fisher Information and Variance Estimation

To compute asymptotic standard errors and confidence intervals, we compute the negative Hessian (Fisher Information Laplacian) matrix $L$:

$$L_{ii} = \sum_{j \neq i} N_{ij} \frac{\pi_i \pi_j}{(\pi_i + \pi_j)^2}$$
$$L_{ij} = -N_{ij} \frac{\pi_i \pi_j}{(\pi_i + \pi_j)^2} \quad (i \neq j)$$

Using the regularized Moore-Penrose pseudo-inverse with centering matrix $\mathbf{J} = \mathbf{1}\mathbf{1}^T$:

$$\Sigma = \left( L + \frac{1}{n}\mathbf{J} + \epsilon I \right)^{-1} - \frac{1}{n}\mathbf{J}$$

The parameter variances $\operatorname{Var}(\theta_i) = \Sigma_{ii}$ yield standard errors and 95% confidence intervals on the 400-point Elo scale:

$$R_i = 1500 + (\theta_i - \bar{\theta}) \times \frac{400}{\ln(10)}$$
$$SE(R_i) = \frac{400}{\ln(10)} \sqrt{\operatorname{Var}(\theta_i)}$$
$$\text{CI}_{95}(R_i) = 1.95996 \times SE(R_i)$$

### 2.3 Ordinal Ranks and Uncertainty

Models are sorted by Bradley-Terry point estimate, with display name as the deterministic tiebreaker. The model at sorted index $i$ receives rank $i + 1$.

Confidence intervals remain visible alongside the rating, but interval overlap does not create tied ranks.

### 2.4 Confidence and Stability Tiers

Confidence shown on leaderboard:

- `confidence = round(max(10, min(99, 100 - min(90, ci95 * 0.85))))`

Stability tier (`lib/arena/rating.ts`):

- `Stable`: decisive votes $\ge 200$, prompt coverage $\ge 0.90$, $\text{CI}_{95} \le 20$
- `Established`: decisive votes $\ge 80$, prompt coverage $\ge 0.80$, $\text{CI}_{95} \le 35$
- otherwise `Provisional`

## 3) Vote handling and counters

Implementation: `app/api/arena/vote/route.ts`, `lib/arena/voteJobs.ts`, `lib/arena/voteMath.ts`.

Vote choices:

- `A`, `B`, `TIE`, `BOTH_BAD`

Behavior:

- `A/B/TIE`:
  - enter the global Bradley-Terry fit as `1`, `0`, or `0.5`
  - increment `winCount/lossCount/drawCount`
  - update the operational per-model state used by matchmaking and private public-anchor evaluation
- `BOTH_BAD`:
  - increment only `bothBadCount` on both models
  - stay out of the Bradley-Terry fit and operational rating update

The public leaderboard is refit from eligible public vote history. Private evaluation votes are excluded from the public fit and counters.

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
- `Rating`: Bradley-Terry point estimate with its 95% confidence interval
- `Confidence`: derived from confidence-interval width
- `Coverage`: `coveredPrompts / activePrompts` plus percent
- `Consistency`: shrunk prompt-strength ES-gap mapped onto a `0-100` score
- `Spread`: stddev of per-prompt observed scores across covered prompts
- `Avg score`: unweighted mean of per-prompt observed scores across covered prompts
- `Record`: W/L/D
- `Votes`: total votes + both-bad count

### 8.2 Derived metrics

- `qualityFloorScore = max(0, 1 - bothBadCount / totalVotes)`
- `pairCoverageScore` (top band):
  - for each adjacent neighbor, compute `pairCompletion`
  - `pairCompletion = min(1, decisiveVotes/12, promptCount/6)`
  - score shown as average completion percent across immediate neighbors

### 8.3 Dispersion and consistency

`lib/arena/stats.ts` computes per-model prompt samples from decisive outcomes.

All three public prompt-summary stats retain prompts with at least 2 decisive votes for that model.

Raw prompt score inputs on that retained prompt set:

- per prompt average score in `[0,1]`
- `meanScore = average(promptAverages)`
- `scoreSpread = sqrt(VAR_POP(promptAverages))`

That retained prompt sample is built from:

- eligible prompts only
- decisive votes only
- active ranked models on both sides of the matchup

The important design change is that public prompt consistency should no longer be driven by raw observed prompt-score spread alone.

Prompt-local percentile is the right primitive:

For each prompt:

- fit a prompt-local Bradley-Terry model from decisive votes on that prompt
- rank active leaderboard models by prompt-local latent strength
- convert rank to percentile, where `100 = best on that prompt` and `0 = weakest`

Implemented branch version:

- keep prompts with at least 2 decisive votes
- if fewer than 5 prompts remain, `consistency = null`
- fit a global Bradley-Terry baseline across decisive votes
- fit prompt-local Bradley-Terry strengths with a symmetric `0.5`/`0.5` pseudo-point prior on each observed model-pair edge
- estimate prompt-level variances from the same prior-augmented edge totals
- shrink prompt-local strengths back toward the global baseline before ranking
- convert shrunk prompt-local ranks to prompt-strength percentiles
- sort prompt-strength percentiles ascending
- let `k = max(1, ceil(0.2 * n))`
- `lowTail = average(bottom k percentiles)`
- `highTail = average(top k percentiles)`
- `gap = highTail - lowTail`
- `consistency = round(clamp(100 - gap - 0.75 * gap^2 / 100, 0, 100), 1)`

Notation:

- \(i\) = model
- \(p\) = prompt
- \(N_p\) = active ranked models with usable prompt signal on prompt \(p\)
- \(n_i\) = retained prompts for model \(i\)
- \(k_i = \max(1, \lceil 0.2 \cdot n_i \rceil)\)
- \(\tilde{r}_{i,p}\) = shrunk prompt-local rank
- \(\tilde{q}_{i,p}\) = shrunk prompt-strength percentile

The percentile mapping is:

\[
\tilde{q}_{i,p} =
\begin{cases}
100, & N_p \le 1 \\
100 \cdot \dfrac{N_p - \tilde{r}_{i,p}}{N_p - 1}, & N_p > 1
\end{cases}
\]

For each model \(i\), let \(\tilde{q}_{i,(t)}\) be the ordered retained prompt-strength percentiles. Then:

\[
L_i = \frac{1}{k_i}\sum_{t=1}^{k_i} \tilde{q}_{i,(t)}, \qquad
U_i = \frac{1}{k_i}\sum_{t=n_i-k_i+1}^{n_i} \tilde{q}_{i,(t)}
\]

\[
G_i = U_i - L_i
\]

\[
\operatorname{Consistency}_i =
\operatorname{clamp}\left(100 - G_i - 0.75 \cdot \frac{G_i^2}{100}, 0, 100\right)
\]

See [Consistency Metric: Prompt-Strength Tail Gap](./consistency-metric-percentile-band.md) for:

- the schedule-confounding problem
- the empirical-Bayes shrinkage path
- the residual-based alternative
- the April 22, 2026 validation snapshot

So the intended public split is:

- `Consistency`: strongest-vs-weakest prompt-strength tail gap, inverted onto `0-100`
- `Spread`: raw observed prompt-score variability
- `Avg score`: unweighted mean of per-prompt observed scores

### 8.4 Model detail prompt graph

The model detail page graph uses prompt-local strength percentile as its primary prompt signal.

That means the page now answers:

- how strong is this model on each prompt relative to the field

instead of:

- how many raw head-to-head points did it earn against the sampled opponents on that prompt

Raw observed prompt score still appears as secondary context on the detail page.

The companion consistency doc explains why this separation matters:

- prompt graph = field-relative prompt strength
- public consistency = an aggregate of those field-relative prompt strengths
- residual-based schedule adjustment is more appropriate as a research/diagnostic lens than as the headline public stat

## 9) What changed from older Elo behavior

Old behavior (historical):

- Elo-only public rating
- weaker coverage control
- `BOTH_BAD` affected loss/rating path

Current behavior:

- global Bradley-Terry public ratings with 95% confidence intervals
- unique ordinal ordering by Bradley-Terry point estimate
- sequential operational state retained for matchmaking and private public anchors
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
- Consistency companion doc: `docs/consistency-metric-percentile-band.md`
