# Arena Ranking

MineBench ranks public models from blind head-to-head votes using a global Bradley-Terry model. Matchmaking separately maintains lightweight operational rating state so it can schedule informative comparisons without changing the published ranking method.

## Eligible evidence

A vote enters the public fit only when:

- both models are enabled, non-baseline public models;
- the prompt is active and has Arena-ready builds from at least two eligible models; and
- the choice is `A`, `B`, or `TIE`.

`A` contributes `1` point to model A, `B` contributes `1` point to model B, and `TIE` contributes `0.5` to each. `BOTH_BAD` is tracked as a quality signal and does not enter the skill fit.

Private checkpoint matchups are excluded from public ratings, counters, coverage, rank snapshots, and leaderboard eligibility.

## Bradley-Terry model

For latent abilities \(\theta_A\) and \(\theta_B\):

\[
P(A > B) = \frac{1}{1 + e^{-(\theta_A - \theta_B)}}
\]

Votes are aggregated by model pair. Each observed edge receives a symmetric prior of `0.5` points per model and `1` total comparison, preventing infinite estimates when one model has no wins or losses on that edge.

With \(\pi_i = e^{\theta_i}\), the iterative update is:

\[
\pi_i^{(t+1)} =
\frac{W_i}{\sum_{j \ne i} \frac{N_{ij}}{\pi_i^{(t)} + \pi_j^{(t)}}}
\]

The fitted abilities are centered and converted to a 1500-centered, 400-point Elo scale:

\[
R_i = 1500 + (\theta_i - \bar{\theta})\frac{400}{\ln 10}
\]

The observed Fisher information supplies an asymptotic variance for each fitted ability. MineBench reports:

\[
SE(R_i) = \frac{400}{\ln 10}\sqrt{\operatorname{Var}(\theta_i)}
\]

\[
CI_{95}(R_i) = 1.95996 \times SE(R_i)
\]

The public comparison graph should remain connected. Disconnected components are fit independently and therefore do not have a shared absolute offset.

## Rank, confidence, and stability

Models are sorted by Bradley-Terry point estimate, with display name as the deterministic tiebreaker. Sorted index \(i\) receives rank \(i + 1\); confidence-interval overlap does not create tied ranks.

The displayed confidence indicator is a bounded transformation of interval width:

```text
round(max(10, min(99, 100 - min(90, CI95 * 0.85))))
```

Stability also requires sufficient rated outcomes and prompt coverage:

| Tier | W/L/D outcomes | Prompt coverage | 95% interval half-width |
| --- | ---: | ---: | ---: |
| Stable | at least 200 | at least 90% | at most 20 |
| Established | at least 80 | at least 80% | at most 35 |
| Provisional | otherwise | otherwise | otherwise |

Rank snapshots use the same Bradley-Terry fit, rank, and confidence values as the leaderboard.

## Vote processing and rating boundaries

Public votes are written first and processed by `ArenaVoteJob`. The job updates W/L/D/`BOTH_BAD` counters, coverage, and sequential operational Glicko state used by matchmaking.

The operational state is not the published score. The leaderboard and model detail pages refit Bradley-Terry from eligible public vote history.

For private matchups, the public model is a read-only anchor. Only the private `StealthVariant` rating and counters change.

## Personal rankings

Personal rankings are a per-account view of public Arena evidence. The fit uses
only that account's eligible `A`, `B`, and `TIE` votes, follows the public model
and prompt eligibility rules, and uses global Bradley-Terry abilities to anchor
disconnected personal comparison components.

This calculation is read-only: it does not update public ratings, counters,
coverage, snapshots, or matchmaking state. Anonymous public votes from the same
browser session are linked when sign-in completes. Private-evaluation votes are
excluded and are never linked to public accounts.

## Matchmaking

Each matchup request samples a lane and falls back to the others if the selected lane cannot produce a valid pair.

| Lane | Weight | Purpose |
| --- | ---: | --- |
| Coverage | 40% | Fill weak model, pair, and prompt coverage |
| Contender | 30% | Improve ordering among nearby top models |
| Uncertainty | 20% | Prefer comparisons with high expected information |
| Exploration | 10% | Preserve discovery and low-exposure traffic |

The contender band contains the top eight models by operational conservative score. Adjacent pairs are prioritized until they have at least 12 decisive votes across at least 6 prompts.

For a selected pair, the lowest-scoring shared prompt is chosen:

| Lane | Prompt score |
| --- | --- |
| Coverage | `votesA + votesB + 6 * pairPromptVotes` |
| Contender | `10 * pairPromptVotes + 0.25 * abs(votesA - votesB)` |
| Uncertainty | `3 * pairPromptVotes + abs(votesA - votesB) + (votesA + votesB) / 2` |
| Exploration | `2 * pairPromptVotes + (votesA + votesB) / 2` |

Here, `votesA` and `votesB` are decisive votes for each model on the prompt, and `pairPromptVotes` is decisive coverage for that exact pair and prompt.

## Leaderboard metrics

- `Rating`: Bradley-Terry point estimate and 95% confidence interval
- `Confidence`: interval-width indicator
- `Coverage`: prompts with sufficient decisive evidence divided by Arena-eligible prompts
- `Consistency`: prompt-strength tail-gap score
- `Spread`: standard deviation of retained per-prompt observed scores
- `Avg score`: unweighted mean of retained per-prompt observed scores
- `Record`: wins, losses, and draws
- `Votes`: rated outcomes plus `BOTH_BAD`
- `Quality floor`: `max(0, 1 - bothBadCount / totalVotes)`
- `Pair coverage`: adjacent top-band completion against the 12-vote, 6-prompt target

The consistency estimator is documented separately in [Consistency Metric](./consistency-metric-percentile-band.md).

## Operations

`pnpm elo:recompute` performs a read-only replay. `pnpm elo:recompute --yes` writes current public Bradley-Terry ratings and counters while independently replaying private variant state. Private votes never enter the public fit.

## Implementation references

- Rating helpers: `lib/arena/rating.ts`
- Bradley-Terry fit and leaderboard statistics: `lib/arena/stats.ts`
- Matchmaking: `app/api/arena/matchup/route.ts`
- Vote processing: `lib/arena/voteJobs.ts`
- Eligible prompt universe: `lib/arena/eligibility.ts`
- Leaderboard API: `app/api/leaderboard/route.ts`
- Personal ranking: `lib/account/personalRanking.ts`
- Rank snapshots: `app/api/admin/rank-snapshots/capture/route.ts`
- Rating replay: `scripts/recompute-elo.ts`
