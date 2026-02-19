# MineBench Arena Ranking Validity Policy v2

Status: Implemented (current system)  
Owner: Arena/Leaderboard  
Scope: Arena matchmaking, rating updates, leaderboard publication rules

Implementation deep-dive: [Arena Ranking System (Math + Matchmaking)](./arena-ranking-system.md)

## 1. Why This Policy Exists

MineBench needs rankings that are understandable, reproducible, and resistant to sampling noise.

v2 exists to ensure:

- top ranks are not dominated by short-run luck,
- uncertainty is visible,
- top contenders are compared frequently enough,
- prompt coverage is balanced enough to reduce prompt-luck bias.

## 2. Policy Outcome (What v2 changed)

v2 replaces Elo-first ordering with a confidence-aware system:

- Glicko-style rating state (`rating`, `RD`, `volatility`)
- public ordering by conservative score (`rating - 2*RD`)
- lane-based matchup scheduler (coverage, contender, uncertainty, exploration)
- `BOTH_BAD` treated as quality-floor signal, not pairwise skill loss

## 3. Core Definitions

- Decisive vote: `A` or `B`
- Non-decisive vote: `TIE` or `BOTH_BAD`
- Prompt coverage floor per model-prompt: `>= 2` decisive votes
- Conservative score: `rating - 2 * RD`
- Contender band: top `K=8` by conservative score

## 4. Rating Policy

### 4.1 Primary rating engine

Use Glicko-style updates for `A`, `B`, `TIE` outcomes.

### 4.2 Public ranking policy

Sort leaderboard by conservative score (not raw rating).

### 4.3 Stability labeling

A model’s public stability label depends on:

- decisive vote volume,
- prompt coverage,
- uncertainty (`RD`).

## 5. Matchmaking Policy

Each matchup request is assigned one lane:

- Coverage lane: 40%
- Contender lane: 30%
- Uncertainty lane: 20%
- Exploration lane: 10%

If the selected lane cannot produce a valid matchup, fallback lanes are attempted.

### 5.1 Coverage lane

Prioritize low-coverage models/pairs/prompts to reduce imbalance.

### 5.2 Contender lane

Prioritize top-band ordering quality:

- adjacent contender pairs are over-sampled until floors are met,
- nearest-rating opponents are preferred,
- prompt choice favors under-covered pair-prompts.

### 5.3 Uncertainty lane

Prioritize highest expected information gain to reduce uncertainty quickly.

### 5.4 Exploration lane

Retain discovery via inverse-exposure randomization.

## 6. Coverage Guarantees

### 6.1 Prompt coverage definition

`promptCoverage = coveredPrompts / activePrompts`

Where `activePrompts` means arena-eligible prompts (not merely all active prompt rows).

### 6.2 Top-pair coverage floor

For adjacent contender pairs, target floor is:

- at least 12 decisive votes,
- across at least 6 distinct prompts.

## 7. Vote Handling Policy

### 7.1 Decisive outcomes

`A`/`B` update skill ratings and W/L counters.

### 7.2 Ties

`TIE` updates both as 0.5 outcome and increments draw counters.

### 7.3 Both-bad outcomes

`BOTH_BAD` does not mutate pairwise rating state.

Track quality-floor diagnostics instead:

- `bothBadCount`
- `qualityFloorScore = 1 - bothBadCount/totalVotes`

## 8. Leaderboard Presentation Policy

Main leaderboard keeps a compact view but must expose validity context:

- `Rating` column shows conservative rank score (primary) with raw rating (secondary)
- `Confidence` from RD
- `Coverage` as covered/eligible prompts
- `Stability` badge in model cell
- keep consistency/spread/avg-score/record/votes

Advanced diagnostics (e.g., pair-coverage detail) may remain on detail pages/tooltips.

## 9. Publication and Trust Policy

To claim leaderboard is strongly calibrated, monitor:

- top-band RD health,
- adjacent-pair coverage completion,
- high prompt coverage across top models.

If these are weak, leaderboard remains visible but should be treated as calibrating.

## 10. Integrity Controls

- Randomized left/right assignment
- One vote per session per matchup
- Ongoing anti-bot and duplicate-vote protections

## 11. Rollout Notes

v2 is implemented in current code paths for:

- matchmaking,
- vote updates,
- leaderboard ordering and metrics.

Detailed formulas and route-level behavior are documented in:

- [Arena Ranking System (Math + Matchmaking)](./arena-ranking-system.md)
