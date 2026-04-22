# Consistency Metric Proposal: Schedule-Adjusted Prompt Tail Span

Status: proposal only. No leaderboard code has been changed yet.

Last updated: April 21, 2026

Scope: define a better public `consistency` metric for MineBench and record the research findings that led to it.

## Why this doc exists

MineBench's current public `consistency` field does not quite answer the question users actually ask.

What users mean by consistency is usually:

- does this model stay in roughly the same quality band across prompts
- does it avoid dramatic highs and lows
- if it has one amazing build and one awful build, does the metric punish that hard

What the current metric actually measures is:

- how spread out the model's raw prompt-level observed head-to-head scores are

Those are related, but not the same thing.

This document records:

- the exact current production metric
- the failure mode we found in prompt score interpretation
- why the first replacement ideas were still incomplete
- the newly recommended metric
- the exact formula and implementation rules
- a production snapshot of all current leaderboard models under the new metric

## Source of truth today

Current implementation references:

- [lib/arena/stats.ts](../lib/arena/stats.ts)
- [lib/arena/rating.ts](../lib/arena/rating.ts)
- [app/api/leaderboard/route.ts](../app/api/leaderboard/route.ts)
- [docs/arena-ranking-system.md](./arena-ranking-system.md)

Current public documentation of the metric lives in [docs/arena-ranking-system.md](./arena-ranking-system.md#83-dispersion-and-consistency).

## Current production metric

### Data inputs

For each model and prompt, MineBench computes a per-prompt observed score from decisive arena votes only:

- win = `1.0`
- loss = `0.0`
- tie = `0.5`
- `BOTH_BAD` is excluded from this prompt score calculation

This logic is implemented in [lib/arena/stats.ts](../lib/arena/stats.ts#L379-L422).

### Current formula

Let:

- `s_p` = the model's observed average score on prompt `p`
- `P` = the set of sampled prompts with at least one decisive vote
- `meanScore = average(s_p for p in P)`
- `scoreSpread = sqrt(VAR_POP(s_p for p in P))`

Current public consistency is:

```text
consistency = round(100 * (1 - min(0.5, scoreSpread) / 0.5))
```

In code, the current calculation is in [lib/arena/stats.ts](../lib/arena/stats.ts#L163-L225).

### What this metric really means

The current metric is a transformed prompt-level standard deviation over observed head-to-head scores.

- low spread -> high consistency
- high spread -> low consistency

That is mathematically clean.

It is not yet the same as:

- prompt reliability
- prompt robustness
- prompt-intrinsic quality stability

## The key fallacy we found

The main issue is not just the spread formula. It is the meaning of the underlying prompt score.

### Raw prompt score is relative, not absolute

A prompt score like `49%` does **not** mean:

- "this build is worse than 51% of all builds on that prompt"
- "this build is below the benchmark median in any absolute sense"

It means:

- against the specific opponents this model actually faced on that prompt
- averaging `win=1`, `tie=0.5`, `loss=0`
- the model earned `49%` of the available head-to-head points

This is exactly how MineBench computes prompt breakdowns in [lib/arena/stats.ts](../lib/arena/stats.ts#L381-L405).

### Why scheduling confounds prompt scores

MineBench does **not** sample prompt-opponent pairs uniformly.

The scheduler intentionally prioritizes:

- under-covered pairs and pair-prompts
- contender stabilization near the top band
- uncertainty reduction
- some exploration

Relevant implementation notes are documented in:

- [docs/arena-ranking-system.md](./arena-ranking-system.md#4-matchup-selection-lanes)
- [docs/arena-ranking-system.md](./arena-ranking-system.md#5-prompt-selection-math-for-a-chosen-pair)

Important consequences:

- top models are more likely to face similarly strong opponents
- exact prompt-pair deficits are explicitly targeted
- a prompt score can look weak partly because the model faced a tougher opponent mix on that prompt

So the observed prompt score is a valid arena stat, but not a deconfounded prompt-quality stat.

## Concrete example: Gemini 3.1 Pro treehouse

This was the clearest prompt that surfaced the issue.

Production snapshot date: April 21, 2026

For `Gemini 3.1 Pro` on the `treehouse village` prompt:

- observed prompt score: about `49.2%`
- decisive votes: `553`

At first glance, that looks like "Gemini has a bad treehouse build."

That interpretation is too naive.

After adjusting for the actual opponents Gemini faced on that prompt using MineBench's own `expectedScore()` formulation from [lib/arena/rating.ts](../lib/arena/rating.ts#L134-L136):

- expected score vs schedule: about `77.4%`
- adjusted prompt residual: about `-0.282`

This tells us two different things:

1. the raw `49.2%` should **not** be read as an absolute benchmark percentile
2. even after schedule adjustment, Gemini really does underperform its own baseline on that prompt

So the fallacy is real, but the prompt can still be genuinely weak after correction.

That is exactly why the replacement metric should use **adjusted prompt residuals**, not raw observed prompt scores.

## Model detail page graph

The model detail page currently treats prompt `averageScore` as the canonical prompt signal.

Relevant implementation points:

- prompt cards and sorting are driven by `averageScore` in [lib/arena/stats.ts](../lib/arena/stats.ts#L578-L600)
- the spread curve sorts by `averageScore` in [components/leaderboard/ModelDetail.tsx](../components/leaderboard/ModelDetail.tsx#L937-L947)
- hover states and prompt bars display `averageScore` directly in [components/leaderboard/ModelDetail.tsx](../components/leaderboard/ModelDetail.tsx#L1534-L1551) and [components/leaderboard/ModelDetail.tsx](../components/leaderboard/ModelDetail.tsx#L1669-L1717)

### Why the current graph is misleading

Today the graph visually implies:

- strongest prompt = highest intrinsic-quality prompt
- weakest prompt = lowest intrinsic-quality prompt

But what it is actually plotting is:

- strongest observed prompt result against the schedule that happened to be sampled
- weakest observed prompt result against the schedule that happened to be sampled

That is why prompts like Gemini 3.1 Pro treehouse can look far weaker than users expect from direct visual inspection.

### Recommended replacement for the graph

The best graph metric is not raw observed score and not the current adjusted residual.

Instead, the graph should use a **prompt-local strength percentile**:

1. for each prompt, fit a prompt-local Bradley-Terry model from that prompt's pairwise votes only
2. rank all active leaderboard models on that prompt by their prompt-local latent strength
3. convert that rank to a percentile

Suggested display semantics:

- `100%` = best-performing build on that prompt
- `50%` = middle of the leaderboard on that prompt
- `0%` = weakest-performing build on that prompt

This makes the graph interpretable in exactly the way users expect.

### Gemini treehouse under the graph replacement

Under the prompt-local ranking approach, `Gemini 3.1 Pro` on `treehouse village` is:

- about `86.1%` prompt-strength percentile
- about rank `#6` among current active leaderboard models on that prompt

That is far more faithful to the intuitive reading of the build than the current observed `49.2%`.

### Recommended UI split

The page should expose three different prompt numbers:

- `Prompt strength`: prompt-local percentile rank
- `Observed score`: current raw head-to-head average
- `Expected vs schedule`: optional context or hover detail

Recommended chart behavior:

- replace the current spread curve and strongest/weakest lists with prompt-strength percentile
- keep observed score only as a secondary detail on hover, tooltip, or expanded prompt rows

This preserves research detail without letting the primary visual tell the wrong story.

## Candidate metrics considered

### 1. Lower-tail gap

Earlier proposal:

```text
mean prompt score - average(bottom quartile prompt scores)
```

Good for:

- robustness
- weak-tail reliability

Bad for:

- consistency as users describe it

Why:

- it only penalizes bad outliers
- it does not penalize unusually good outliers

So this is better treated as a future `Robustness` metric, not as the replacement for `Consistency`.

### 2. Raw two-sided tail span

Next proposal:

```text
average(top k prompt scores) - average(bottom k prompt scores)
```

Good for:

- punishing both highs and lows
- matching the intuition that "one best-ever prompt and one worst-ever prompt" should mean low consistency

Still incomplete because:

- it is still built on **raw observed prompt scores**
- those prompt scores are confounded by the scheduler

### 3. Schedule-adjusted tail span with linear mapping

This fixes the conceptual problem:

- subtract expected score vs actual opponents
- measure prompt-to-prompt spread on those residuals

But a simple linear 0-100 mapping still came out harsher than desired for models that look genuinely stable after adjustment, especially frontier leaders like GPT 5.4 Pro.

## Recommended metric

### Short name

Recommended public label:

- `Consistency`

Recommended internal/raw statistic name:

- `adjustedPromptTailSpan`

### Exact definition

For each decisive vote `v` involving model `i` against opponent `j` on prompt `p`:

```text
observed(i, v) = 1.0 if i wins
               = 0.5 if tie
               = 0.0 if i loses

expected(i, v) = expectedScore(conservativeRating_i, conservativeRating_j)

residual(i, v) = observed(i, v) - expected(i, v)
```

This uses the same logistic expectation helper MineBench already exposes in [lib/arena/rating.ts](../lib/arena/rating.ts#L134-L136).

For each model `i` and prompt `p`:

```text
promptResidual(i, p) = average(residual(i, v) over decisive votes on prompt p)
```

Then:

1. keep only arena-eligible prompts from [lib/arena/eligibility.ts](../lib/arena/eligibility.ts)
2. keep only prompts with at least `PROMPT_COVERAGE_FLOOR = 2` decisive votes
3. if fewer than `MIN_PROMPTS_FOR_SPREAD = 3` prompts remain, return `null`
4. sort prompt residuals ascending
5. let `k = max(1, ceil(0.2 * n))`
6. compute:

```text
lowTail = average(bottom k promptResiduals)
highTail = average(top k promptResiduals)
adjustedPromptTailSpan = highTail - lowTail
```

Finally map that raw span to a public 0-100 score with a quadratic transform:

```text
x = min(0.5, adjustedPromptTailSpan) / 0.5
consistencyVNext = round(100 * (1 - x^2))
```

### Why this is the best current proposal

It solves both problems we found:

1. **schedule confound**
   - prompt performance is judged relative to the actual opponents faced

2. **public-score calibration**
   - modest adjusted spans are not over-penalized
   - truly swingy models still drop hard

This also keeps a useful separation:

- raw research quantity = `adjustedPromptTailSpan`
- public leaderboard score = `consistencyVNext`

### Why quadratic instead of linear

The linear transform:

```text
100 * (1 - x)
```

was too harsh in the high-consistency region.

The quadratic transform:

```text
100 * (1 - x^2)
```

has better behavior for the use case MineBench cares about:

- top models with modest adjusted variance still score high
- highly swingy models still score low
- the formula stays simple and transparent

## Interpretation

Under the recommended metric:

- `90+` = extremely stable after opponent adjustment
- `75-89` = strong consistency
- `55-74` = noticeable prompt volatility, but not extreme
- `35-54` = clear prompt-to-prompt swings
- below `35` = severe prompt inconsistency even after schedule adjustment

## Worked examples

### GPT 5.4 Pro

Production snapshot:

- current public consistency: `88`
- adjusted prompt tail span: about `0.160`
- proposed new consistency: `90`

This is the clearest sign that schedule adjustment plus a gentler mapping fixes the earlier over-penalization problem.

### Gemini 3.1 Pro

Production snapshot:

- current public consistency: `80`
- adjusted prompt tail span: about `0.279`
- proposed new consistency: `69`

This lands lower than the current metric, but far more sensibly than the earlier raw-tail proposal.

Important nuance:

- Gemini's treehouse prompt still looks genuinely weak after adjustment
- so the lower score is not just a scheduler artifact

### Kimi K2.6

Production snapshot:

- current public consistency: `75`
- adjusted prompt tail span: about `0.355`
- proposed new consistency: `50`

This still marks Kimi as clearly inconsistent across prompts, but no longer uses raw observed scores that are confounded by schedule.

### Grok 4.20

Production snapshot:

- current public consistency: `69`
- adjusted prompt tail span: about `0.453`
- proposed new consistency: `18`

This is exactly the kind of model profile the new metric is meant to punish:

- some very strong prompts
- some very weak prompts
- very wide adjusted prompt spread

## Full production snapshot

Snapshot date: April 21, 2026

Data sources:

- production leaderboard API for current rank and current public consistency
- production arena database for vote-level adjusted prompt residuals

Formula used in this snapshot:

```text
adjustedPromptTailSpan = average(top 20% prompt residuals) - average(bottom 20% prompt residuals)
consistencyVNext = round(100 * (1 - (min(0.5, adjustedPromptTailSpan) / 0.5)^2))
```

| Rank | Model | Current | Proposed | Delta | Raw adjusted span |
|---|---|---:|---:|---:|---:|
| 1 | GPT 5.4 Pro | 88 | 90 | +2 | 0.160 |
| 2 | Gemini 3.1 Pro | 80 | 69 | -11 | 0.279 |
| 3 | GPT 5.4 | 86 | 83 | -3 | 0.206 |
| 4 | Claude 4.7 Opus | 82 | 73 | -9 | 0.261 |
| 5 | GPT 5.2 Pro | 75 | 53 | -22 | 0.343 |
| 6 | GPT 5.3 Codex | 77 | 62 | -15 | 0.308 |
| 7 | GPT 5.2 | 82 | 77 | -5 | 0.242 |
| 8 | Claude 4.6 Opus | 71 | 59 | -12 | 0.320 |
| 9 | Gemini 3.0 Flash | 77 | 66 | -11 | 0.291 |
| 10 | Kimi K2.6 | 75 | 50 | -25 | 0.355 |
| 11 | Gemini 3.0 Pro | 70 | 36 | -34 | 0.399 |
| 12 | GPT 5.4 Mini | 74 | 54 | -20 | 0.338 |
| 13 | Claude 4.6 Sonnet | 76 | 55 | -21 | 0.335 |
| 14 | Claude 4.5 Opus | 79 | 72 | -7 | 0.262 |
| 15 | Grok 4.20 | 69 | 18 | -51 | 0.453 |
| 16 | Qwen 3.5 397B A17B | 67 | 33 | -34 | 0.408 |
| 17 | Z.AI GLM 5 | 85 | 86 | +1 | 0.186 |
| 18 | GPT 5.4 Nano | 68 | 17 | -51 | 0.455 |
| 19 | Gemma 4 31B | 72 | 44 | -28 | 0.373 |
| 20 | MiniMax M2.7 | 76 | 49 | -27 | 0.356 |
| 21 | Kimi K2.5 | 70 | 43 | -27 | 0.377 |
| 22 | Claude 4.5 Sonnet | 76 | 62 | -14 | 0.309 |
| 23 | Gemini 2.5 Pro | 66 | 14 | -52 | 0.463 |
| 24 | Z.AI GLM 4.7 | 76 | 62 | -14 | 0.310 |
| 25 | GPT 5 Mini | 67 | 30 | -37 | 0.419 |
| 26 | MiniMax M2.5 | 69 | 47 | -22 | 0.363 |
| 27 | GPT 5.2 Codex | 77 | 63 | -14 | 0.303 |
| 28 | GPT 4.1 | 72 | 47 | -25 | 0.365 |
| 29 | DeepSeek V3.2 | 80 | 71 | -9 | 0.268 |
| 30 | Gemini 3.1 Flash-Lite | 76 | 58 | -18 | 0.324 |
| 31 | Kimi K2 | 71 | 49 | -22 | 0.359 |
| 32 | Grok 4.1 | 76 | 60 | -16 | 0.316 |
| 33 | GPT 4o | 84 | 81 | -3 | 0.220 |
| 34 | Qwen3 Max Thinking | 69 | 43 | -26 | 0.377 |
| 35 | GPT OSS 120B | 87 | 89 | +2 | 0.164 |
| 36 | Llama 4 Maverick | 89 | 92 | +3 | 0.142 |
| 37 | GPT 5 Nano | 93 | 97 | +4 | 0.091 |

## Implementation notes

This metric can be added without schema changes.

Recommended implementation path:

1. add a new aggregation path in [lib/arena/stats.ts](../lib/arena/stats.ts) next to the existing dispersion query
2. reuse the same arena-eligible prompt filter from [lib/arena/eligibility.ts](../lib/arena/eligibility.ts)
3. compute vote-level expected scores using the current conservative ratings
4. aggregate to prompt residuals per model
5. compute the adjusted tail span
6. expose both:
   - raw `adjustedPromptTailSpan`
   - public `consistency`

Recommended display behavior:

- detail page:
  - keep raw observed prompt `score`
  - add `expected vs schedule`
  - add `adjusted prompt delta`

- leaderboard:
  - replace current public `Consistency` with the new score
  - optionally keep old stddev-style statistic only as `Spread`

## Future upgrade if we want to go further

The best full research-grade version would be a hierarchical paired-comparison model with prompt effects:

```text
logit P(i beats j on prompt p) =
  (overall_strength_i - overall_strength_j)
  + (prompt_effect_i,p - prompt_effect_j,p)
```

That would be stronger than the current recommendation because it would estimate prompt-specific deviations jointly instead of using a fixed baseline expectation from current ratings.

But it is more invasive and slower to explain publicly.

So the recommended implementation order is:

1. ship the schedule-adjusted tail-span metric documented here
2. revisit a hierarchical model later if MineBench needs a fully research-grade prompt-effect estimator

## Verdict

If MineBench wants `Consistency` to mean:

- "does this model stay in the same quality band across prompts, after accounting for who it faced"

then the best current metric is:

- **schedule-adjusted prompt tail span**
- with a **quadratic 0-100 transform**

This is the first proposal in the exploration that:

- punishes both high and low outliers
- corrects for scheduler-induced prompt-score confounding
- keeps genuinely stable top models from being scored implausibly low

## Relationship between prompt graph and consistency

The graph metric and the public consistency metric should **not** necessarily be the same quantity.

### Best practical split today

- model detail graph: prompt-local strength percentile
- public consistency: schedule-adjusted prompt tail span from residuals

Why this split works:

- the graph needs to be visually intuitive
- the consistency metric needs to stay sensitive to prompt-to-prompt volatility

### Why not reuse prompt percentile directly for consistency

Prompt percentile is excellent for display.

It is too forgiving as a consistency basis.

When tested as a direct consistency input, it made frontier models look almost perfectly consistent:

- GPT 5.4 Pro would land around `99`
- Gemini 3.1 Pro would land around `93`

That is probably too soft, because it compresses large latent prompt differences into bounded rank percentiles.

### Why prompt-local latent strength is still interesting for consistency

A stronger long-term version of consistency would use prompt-local latent strengths directly:

```text
theta(i, p) = prompt-local Bradley-Terry strength for model i on prompt p
effect(i, p) = theta(i, p) - average_p(theta(i, p))
consistency = low spread of effect(i, p)
```

This is conceptually cleaner than the current residual-based proposal.

However:

- the raw scale is much wider
- the score mapping would need a separate calibration pass
- it is not yet as implementation-ready as the residual-based proposal

So the recommended rollout order is:

1. replace prompt-page graphing with prompt-local percentile
2. if the public consistency metric is updated now, use the residual-based proposal
3. later, evaluate whether a prompt-local latent-effect consistency metric should replace the residual-based one
