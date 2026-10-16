# Consistency Metric: Prompt-Strength Tail Gap

MineBench reports `Consistency` as a `0-100` summary of how steadily a model stays in the same field-relative quality band across benchmark prompts.

The metric is built from the same prompt-strength signal used on model detail pages:

- estimate each model's strength on each prompt from active head-to-head votes,
- shrink sparse prompt estimates toward the model's global ability,
- convert each prompt-local estimate into a percentile within the active model field,
- compare the model's strongest and weakest prompt-strength tails.

Higher is steadier. Lower means the model has larger prompt-to-prompt swings.

## Why Raw Prompt Scores Are Not Enough

A raw prompt score is the average head-to-head outcome on that prompt:

- win = `1.0`
- tie = `0.5`
- loss = `0.0`
- `BOTH_BAD` excluded from the skill signal

That score is useful, but it depends heavily on the sampled opponents. MineBench matchmaking is coverage-aware and contender-heavy, so strong models often face other strong models on the same prompt. A model can have a modest raw score on a prompt while still being one of the best active models for that prompt.

The model-detail page therefore separates two ideas:

- `Prompt strength`: field-relative percentile for that prompt.
- `Observed score`: raw average against the sampled schedule.

`Consistency` is derived from prompt strength, not from raw score alone, so the graph and leaderboard stat use the same interpretation.

## Cohort

The prompt-strength and consistency pipeline uses one aligned vote population:

- active ranked models only,
- arena-eligible prompts only,
- decisive skill outcomes only (`A`, `B`, `TIE`),
- comparisons where both sides are in the active ranked cohort.

Using one cohort matters. Prompt strength, prompt spread, and model-detail summaries should not mix active-only evidence with historical votes against retired or disabled models.

## Statistical Target

The metric estimates:

```math
\text{Consistency}_i \approx \text{how tightly model } i \text{ stays in the same field-relative quality band across prompts.}
```

This is deliberately different from:

- raw prompt win-rate spread,
- deviation from the model's own expected baseline,
- lower-tail-only robustness,
- ordinary rating uncertainty.

## Notation

- $`i, j`$ index models.
- $`p`$ indexes prompts.
- $`N_p`$ is the number of active ranked models with usable prompt signal on prompt $`p`$.
- $`n_i`$ is the number of retained prompts for model $`i`$.
- $`k_i = \max(1, \lceil 0.2 \cdot n_i \rceil)`$ is the tail size used for model $`i`$.
- $`\alpha_i`$ is model $`i`$'s global Bradley-Terry ability.
- $`\hat{\theta}_{i,p}`$ is model $`i`$'s raw prompt-local Bradley-Terry ability on prompt $`p`$.
- $`s_{i,p}^2`$ is the approximate posterior variance of $`\hat{\theta}_{i,p}`$.
- $`\tau_p^2`$ is the between-model prompt variance used for shrinkage on prompt $`p`$.
- $`\rho_{i,p}`$ is the shrinkage weight for model $`i`$ on prompt $`p`$.
- $`\tilde{\theta}_{i,p}`$ is the shrunk prompt-local ability.
- $`\tilde{r}_{i,p}`$ is the rank induced by $`\tilde{\theta}_{i,p}`$ on prompt $`p`$.
- $`\tilde{q}_{i,p}`$ is the shrunk prompt-strength percentile shown in the UI.

All prompt-strength percentiles are on a `0-100` scale:

- `100` = strongest active model on that prompt,
- `50` = middle of the active field,
- `0` = weakest active model on that prompt.

## 1. Global Ability

Across all retained comparisons, MineBench fits a global Bradley-Terry model and estimates one prompt-agnostic latent ability $`\alpha_i`$ for each model.

For a decisive comparison between models $`i`$ and $`j`$:

```math
\Pr(i \succ j) =
\frac{\exp(\alpha_i)}
{\exp(\alpha_i) + \exp(\alpha_j)}
```

The fitted scores are centered to handle the usual Bradley-Terry location constraint. These global abilities act as shrinkage anchors for sparse prompt-local estimates.

## 2. Prompt-Local Ability

For each prompt $`p`$, MineBench fits a prompt-local Bradley-Terry model on that prompt's retained votes:

```math
\Pr(i \succ j \mid p) =
\frac{\exp(\hat{\theta}_{i,p})}
{\exp(\hat{\theta}_{i,p}) + \exp(\hat{\theta}_{j,p})}
```

Each observed model-pair edge receives a weak symmetric prior: `0.5` pseudo-points for each model, equivalent to one tied pseudo-comparison. The same augmented edge total is used in the information matrix. This keeps ability and variance estimates finite when observed outcomes have complete or near separation, such as a model with zero wins on a prompt.

The implementation then estimates $`s_{i,p}^2`$, an approximate posterior variance for each prompt-local ability, from the stabilized inverse information matrix of the prompt-local comparison graph. Disconnected prompt components are aligned back onto the global $`\alpha_i`$ scale before shrinkage.

## 3. Prompt-Level Shrinkage

Prompt-level estimates can be noisy when a prompt has few votes or an uneven comparison graph. MineBench shrinks each prompt-local ability toward the model's global ability.

First estimate prompt-level between-model variance:

```math
\tau_p^2 =
\max\left(
0,
\mathrm{Var}(\hat{\theta}_{i,p} - \alpha_i)
-
\mathrm{mean}(s_{i,p}^2)
\right)
```

Then compute each shrinkage weight:

```math
\rho_{i,p} =
\frac{\tau_p^2}{\tau_p^2 + s_{i,p}^2}
```

And the shrunk prompt-local ability:

```math
\tilde{\theta}_{i,p} =
\alpha_i + \rho_{i,p}(\hat{\theta}_{i,p} - \alpha_i)
```

High-confidence prompt evidence moves farther from the global anchor. Sparse or noisy prompt evidence stays closer to the model's global ability. The symmetric edge prior prevents a separated model from contributing effectively infinite variance and forcing the entire prompt's $`\tau_p^2`$ to zero.

## 4. Prompt-Strength Percentile

For each prompt $`p`$:

1. rank active models by $`\tilde{\theta}_{i,p}`$,
2. convert each rank to a percentile.

```math
\tilde{q}_{i,p} =
\begin{cases}
100, & N_p \le 1 \\
100 \cdot \dfrac{N_p - \tilde{r}_{i,p}}{N_p - 1}, & N_p > 1
\end{cases}
```

This percentile is the primary `Prompt strength` value on model detail pages.

## 5. Public Consistency

For each model $`i`$:

1. keep prompts with at least `2` decisive votes,
2. return `null` if fewer than `5` prompts remain,
3. sort $`\tilde{q}_{i,p}`$ from weakest to strongest,
4. let $`k_i = \max(1, \lceil 0.2 \cdot n_i \rceil)`$,
5. compare the bottom and top prompt-strength tails.

Let $`\tilde{q}_{i,(t)}`$ be the $`t`$-th ordered retained prompt-strength percentile:

```math
L_i =
\frac{1}{k_i}
\sum_{t=1}^{k_i} \tilde{q}_{i,(t)}
```

```math
U_i =
\frac{1}{k_i}
\sum_{t=n_i-k_i+1}^{n_i} \tilde{q}_{i,(t)}
```

```math
G_i = U_i - L_i
```

The public score is:

```math
\mathrm{Consistency}_i =
\mathrm{clamp}
\left(
100 - G_i - 0.75 \cdot \frac{G_i^2}{100},
0,
100
\right)
```

This mapping is intentionally convex:

- small prompt-band gaps only lightly affect stable models,
- large prompt-band gaps are penalized more strongly,
- the score remains bounded and easy to read on a `0-100` scale.

## Relationship To Other Leaderboard Stats

`Consistency` is not a replacement for the rest of the leaderboard:

- `Rating` captures head-to-head skill.
- `RD` captures rating uncertainty.
- `Spread` captures raw prompt-score dispersion.
- `Avg score` is the arithmetic mean of retained raw prompt averages.
- `Consistency` summarizes the gap between strongest and weakest prompt-strength tails.

The separation is important because a model can be strong but uneven, weaker but steady, or high-variance because of limited evidence.

## Alternative Considered: Schedule-Adjusted Residual Span

The strongest alternative was a residual-based metric that asks whether a model overperforms or underperforms its expected baseline on each prompt.

For each decisive vote:

```math
e_{i,v} = \mathrm{expectedScore}(C_i, C_j)
```

```math
r_{i,v} = y_{i,v} - e_{i,v}
```

where:

- $`C_i`$ is the conservative rating for model $`i`$,
- $`y_{i,v} \in \{1, 0.5, 0\}`$ is the observed vote score for model $`i`$.

For each prompt:

```math
\bar{r}_{i,p} =
\mathrm{mean}_{v \in p}(r_{i,v})
```

Then:

```math
\mathrm{span}_i =
\mathrm{mean}(\text{top 20\% of } \bar{r}_{i,p})
-
\mathrm{mean}(\text{bottom 20\% of } \bar{r}_{i,p})
```

```math
x_i =
\frac{\min(0.5, \mathrm{span}_i)}{0.5}
```

```math
\mathrm{Consistency}^{\text{residual}}_i =
\mathrm{round}\left(100(1 - x_i^2), 1\right)
```

This residual metric is valuable as a research diagnostic:

- it measures prompt-to-prompt deviation from a model's expected baseline,
- it catches models that are unusually spiky relative to their own rating,
- it is harsher when a prompt outcome is surprising after schedule adjustment.

It is not the headline public stat because it answers a different question. A model can underperform its own baseline on a prompt and still be one of the best models in the field on that prompt. The public UI is easier to interpret when the prompt graph and leaderboard consistency both use field-relative prompt strength.

## References

- Leaderboard aggregation: [`lib/arena/stats.ts`](../lib/arena/stats.ts)
- Leaderboard API: [`app/api/leaderboard/route.ts`](../app/api/leaderboard/route.ts)
- Rating expectation helper: [`lib/arena/rating.ts`](../lib/arena/rating.ts)
- Model detail UI: [`components/leaderboard/ModelDetail.tsx`](../components/leaderboard/ModelDetail.tsx)
- Leaderboard UI: [`components/leaderboard/Leaderboard.tsx`](../components/leaderboard/Leaderboard.tsx)
- Ranking system overview: [`docs/arena-ranking-system.md`](arena-ranking-system.md)
