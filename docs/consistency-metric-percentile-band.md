# Consistency Metric: Prompt-Local Percentiles, Shrunk ES Gap, and the Residual Alternative

Status: implemented on this branch

Last updated: April 22, 2026

Scope: define the implemented public `Consistency` metric, explain the model-detail prompt graph change, document why raw prompt scores are schedule-confounded, and keep the residual-based alternative as a research comparison.

## Snapshot context

Everything below is tied to the April 22, 2026 production snapshot used in this pass.

- active ranked leaderboard models: `38`
- eligible prompts: `15`
- current public production consistency values shown below come from `https://minebench.ai/api/leaderboard`
- the implemented-metric numbers below come from the current branch codepath on the matching prod-clone snapshot used for local analysis on the same date

These numbers will drift as new votes land.

## What is implemented

If MineBench wants `Consistency` to mean:

- does this model stay in roughly the same field-relative quality band across prompts
- does it avoid big highs and lows
- does it get punished when one prompt is elite and another is weak

the implemented public metric is:

- **shrunk prompt-local strength percentile** as the prompt-page / graph primitive
- **posterior-shrunk convex expected-shortfall gap** on those percentiles as the public `Consistency` score

This is the GPT 5.4 Pro direction implemented as a production-grade empirical-Bayes approximation.

The earlier residual-based metric is still useful, but it is better framed as an internal research diagnostic:

- it measures prompt-to-prompt deviation from a model's own expected baseline
- it does not align with how users read the prompt graph
- it punishes models like `Gemini 3.1 Pro` more than the product meaning of "consistency" probably should

## Why raw prompt scores are misleading

MineBench's current raw prompt score is an observed head-to-head average on the exact schedule that happened to occur for that prompt:

- win = `1.0`
- loss = `0.0`
- tie = `0.5`
- `BOTH_BAD` excluded

That number is useful, but it is not an absolute prompt-quality percentile.

Because matchmaking is coverage-aware and contender-heavy, strong models often face other strong models on the same prompt. That can drag a raw prompt score down even when the build is still one of the best in the field.

### Gemini 3.1 Pro treehouse example

On the April 22, 2026 snapshot, under the implemented branch code:

- observed treehouse score: `48.0%`
- prompt-strength percentile: `86.5%`
- prompt-strength rank: `#6 / 38`

That is the core fallacy we found:

- the raw `48.0%` score looks like a mediocre treehouse build
- the prompt-local paired-comparison evidence says it is still a top-tier treehouse build

So the current large prompt number on the model detail page should not be raw observed score.

## What should change on the model detail page

The model detail page should separate two ideas:

- `Prompt strength`: primary number
- `Observed score`: secondary context

### Primary prompt metric

Use shrunk prompt-local percentile rank:

- `100%` = best active model on that prompt after prompt-level shrinkage
- `50%` = middle of the active field
- `0%` = weakest active model on that prompt

### Secondary prompt metric

Keep the current observed score, but demote it:

- raw head-to-head average against the sampled schedule

### What the graph would mean

The graph becomes a `Prompt strength curve`, not a raw prompt-score curve.

For Gemini 3.1 Pro on the April 22 snapshot:

- current raw observed curve range: about `48.1% -> 88.1%`
- prompt-strength percentile curve range: about `81.1% -> 100.0%`

So the page would stop implying:

- "Gemini has several mediocre prompts"

and start showing:

- "Gemini is strong on almost every prompt, but not equally dominant on all of them"

That is much closer to what users mean when they inspect the prompt breakdown.

## Implemented formula

The branch implementation uses an empirical-Bayes version of the GPT 5.4 Pro design.

### 1. Global prompt-agnostic ability

Across all decisive votes on active prompts:

1. fit a global Bradley-Terry model
2. get a global latent ability `alpha(i)` for each model `i`

This acts as the shrinkage anchor.

### 2. Prompt-local ability

For each prompt `p`:

1. fit a prompt-local Bradley-Terry model on decisive votes for that prompt
2. estimate prompt-local latent ability `theta_hat(i, p)`
3. estimate an approximate posterior variance `s(i, p)^2` from the prompt-level comparison graph
4. align disconnected prompt components back onto the global `alpha(i)` scale before shrinkage

### 3. Prompt-level shrinkage

For each prompt `p`, estimate a between-model prompt variance:

```text
tau(p)^2 = max(0, VAR(theta_hat(i, p) - alpha(i)) - mean(s(i, p)^2))
```

Then shrink each prompt-local estimate toward the global ability:

```text
rho(i, p) = tau(p)^2 / (tau(p)^2 + s(i, p)^2)
theta_tilde(i, p) = alpha(i) + rho(i, p) * (theta_hat(i, p) - alpha(i))
```

Finally:

1. rerank models on prompt `p` by `theta_tilde(i, p)`
2. convert that rank to a percentile `q_tilde(i, p)`

That percentile is the main `Prompt strength` number shown on the model detail page.

### 4. Public consistency

For each model `i`:

1. keep prompts with at least `2` decisive votes
2. if fewer than `5` prompts remain, `consistency = null`
3. sort `q_tilde(i, p)` ascending
4. let `k = max(1, ceil(0.2 * n))`
5. compute:

```text
L(i) = average(bottom k prompt-strength percentiles)
U(i) = average(top k prompt-strength percentiles)
G(i) = U(i) - L(i)

Consistency(i) = clamp(100 - G(i) - 0.75 * G(i)^2 / 100, 0, 100)
```

This gives the intended behavior:

- small prompt-band gaps barely move elite stable models
- large prompt-band gaps get punished materially harder
- the prompt graph and the public consistency score now speak the same language

## Candidate B: schedule-adjusted residual tail span

This was the strongest earlier alternative.

For each decisive vote:

```text
residual = observed - expectedScore(conservativeRating_model, conservativeRating_opponent)
```

For each prompt, average those residuals. Then for each model:

```text
span(i) = average(top 20% promptResiduals) - average(bottom 20% promptResiduals)
x(i) = min(0.5, span(i)) / 0.5

Consistency_residual(i) = round(100 * (1 - x(i)^2), 1)
```

What it measures well:

- prompt-to-prompt deviation from a model's expected baseline
- genuinely spiky models get punished hard

Why it is not the best public stat:

- it is about relative overperformance vs baseline, not field-relative prompt quality
- it can make elite models look too inconsistent when a prompt is still strong in absolute field terms
- it no longer matches the meaning of the prompt graph if the graph is percentile-based

## Why Candidate A is the better public choice

Candidate A fixes the exact user-facing problem that triggered this work:

- a prompt like Gemini 3.1 Pro treehouse should not look weak just because its sampled opponents were brutal

Compared with the residual-based metric, the implemented GPT-style metric:

- keeps `GPT 5.4 Pro` and `Gemini 3.1 Pro` in a much more plausible range
- still punishes models like `Kimi K2.6` and `Grok 4.20` for real prompt-band swings
- uses the same prompt-quality primitive as the prompt graph

The residual metric is still worth keeping around in research notes and internal analysis.

## April 22, 2026 leaderboard comparison

Columns:

- `Current` = live public leaderboard consistency on April 22, 2026
- `Implemented GPT metric` = the current branch implementation
- `Residual alternative` = schedule-adjusted residual tail-span metric

| Rank | Model | Current | Implemented GPT metric | Delta | Residual alternative | Delta |
|---:|---|---:|---:|---:|---:|---:|
| 1 | GPT 5.4 Pro | 87 | 97.2 | +10.2 | 89.0 | +2.0 |
| 2 | Gemini 3.1 Pro | 80 | 86.2 | +6.2 | 68.0 | -12.0 |
| 3 | GPT 5.4 | 85 | 88.3 | +3.3 | 82.8 | -2.2 |
| 4 | Claude 4.7 Opus | 81 | 82.9 | +1.9 | 71.1 | -9.9 |
| 5 | GPT 5.3 Codex | 77 | 80.7 | +3.7 | 61.3 | -15.7 |
| 6 | Z.AI GLM 5.1 | 80 | 73.7 | -6.3 | 69.9 | -10.1 |
| 7 | GPT 5.2 Pro | 74 | 66.2 | -7.8 | 49.8 | -24.2 |
| 8 | GPT 5.2 | 82 | 82.9 | +0.9 | 76.1 | -5.9 |
| 9 | Kimi K2.6 | 75 | 50.0 | -25.0 | 48.3 | -26.7 |
| 10 | Claude 4.6 Opus | 71 | 71.2 | +0.2 | 58.2 | -12.8 |
| 11 | Gemini 3.0 Pro | 70 | 51.4 | -18.6 | 36.1 | -33.9 |
| 12 | Claude 4.6 Sonnet | 76 | 62.3 | -13.7 | 54.7 | -21.3 |
| 13 | Grok 4.20 | 77 | 54.2 | -22.8 | 61.1 | -15.9 |
| 14 | Claude 4.5 Opus | 79 | 63.6 | -15.4 | 72.3 | -6.7 |
| 15 | GPT 5.4 Mini | 74 | 51.4 | -22.6 | 51.5 | -22.5 |
| 16 | GPT 5.4 Nano | 68 | 28.9 | -39.1 | 16.4 | -51.6 |
| 17 | Gemini 3.0 Flash | 78 | 64.9 | -13.1 | 69.1 | -8.9 |
| 18 | Qwen 3.5 397B A17B | 67 | 41.2 | -25.8 | 32.8 | -34.2 |
| 19 | Z.AI GLM 5 | 85 | 74.9 | -10.1 | 85.6 | +0.6 |
| 20 | Kimi K2.5 | 70 | 44.2 | -25.8 | 42.8 | -27.2 |
| 21 | Claude 4.5 Sonnet | 76 | 59.7 | -16.3 | 61.3 | -14.7 |
| 22 | MiniMax M2.7 | 76 | 48.6 | -27.4 | 48.5 | -27.5 |
| 23 | Gemma 4 31B | 71 | 51.4 | -19.6 | 44.6 | -26.4 |
| 24 | Z.AI GLM 4.7 | 76 | 57.0 | -19.0 | 61.4 | -14.6 |
| 25 | GPT 5 Mini | 66 | 47.1 | -18.9 | 29.9 | -36.1 |
| 26 | GPT 5.2 Codex | 77 | 59.7 | -17.3 | 64.6 | -12.4 |
| 27 | Gemini 2.5 Pro | 66 | 36.7 | -29.3 | 19.0 | -47.0 |
| 28 | GPT 4.1 | 72 | 59.7 | -12.3 | 47.7 | -24.3 |
| 29 | Qwen3 Max Thinking | 70 | 52.8 | -17.2 | 49.6 | -20.4 |
| 30 | MiniMax M2.5 | 69 | 51.4 | -17.6 | 46.4 | -22.6 |
| 31 | DeepSeek V3.2 | 80 | 70.0 | -10.0 | 72.7 | -7.3 |
| 32 | Kimi K2 | 71 | 58.3 | -12.7 | 51.0 | -20.0 |
| 33 | Gemini 3.1 Flash-Lite | 76 | 63.6 | -12.4 | 58.4 | -17.6 |
| 34 | Grok 4.1 | 76 | 67.5 | -8.5 | 60.1 | -15.9 |
| 35 | GPT 4o | 84 | 80.7 | -3.3 | 80.2 | -3.8 |
| 36 | GPT OSS 120B | 87 | 92.4 | +5.4 | 89.4 | +2.4 |
| 37 | Llama 4 Maverick | 89 | 90.4 | +1.4 | 91.6 | +2.6 |
| 38 | GPT 5 Nano | 93 | 95.3 | +2.3 | 96.7 | +3.7 |

## How to read the comparison

The biggest signal from the table is:

- the implemented GPT-style metric materially fixes the "Gemini looks unfairly low" problem
- the residual plan remains much harsher on schedule-confounded elite models

Concrete examples:

- `GPT 5.4 Pro`: `87 -> 97.2` under the implemented metric, only `89.0` under the residual alternative
- `Gemini 3.1 Pro`: `80 -> 86.2` under the implemented metric, but `68.0` under the residual alternative
- `Kimi K2.6`: `75 -> 50.0` under the implemented metric and `48.3` under the residual alternative
- `Grok 4.20`: `77 -> 54.2` under the implemented metric and `61.1` under the residual alternative

So the two candidates are not answering the same question:

- implemented GPT-style metric: field-relative prompt-band steadiness
- residual alternative: deviation from expected baseline

## Product split

This branch implements the clean public split:

1. model detail graph primary value = shrunk prompt-strength percentile
2. prompt cards primary value = shrunk prompt-strength percentile
3. observed prompt score stays visible, but secondary
4. public `Consistency` = shrunk convex ES-gap on prompt-strength percentiles
5. `Spread` stays raw
6. `Avg score` stays raw

## Secondary research metric

The residual-based score is still worth preserving, just not as the headline public metric.

Best use:

- internal volatility diagnostic
- model-evaluation notes
- "does this model overperform or underperform its own baseline on certain prompts"

Not the best use:

- the main public `Consistency` stat on the leaderboard

## Companion references

- leaderboard API: `app/api/leaderboard/route.ts`
- leaderboard/detail aggregation: `lib/arena/stats.ts`
- rating expectation helper: `lib/arena/rating.ts`
- model detail UI: `components/leaderboard/ModelDetail.tsx`
- leaderboard UI: `components/leaderboard/Leaderboard.tsx`
- system doc: `docs/arena-ranking-system.md`
