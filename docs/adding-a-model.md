# Adding a Model

Before writing code, read the provider's model card and note four things: the
output ceiling, the reasoning or thinking levels it accepts, whether it rejects a
non-default `temperature`, and whether its API is restricted (Responses-only, a
required beta header, a fixed reasoning mode). Every step below records one of
those facts, once.

Do not copy the values from the previous release in the same family. Providers
change output caps and effort levels between minor versions, and a wrong value
here benchmarks the model on a request it never accepted.

## 1. Register the model

`lib/ai/modelCatalog.ts` is the entry point and the source of identity. Add one
entry to `CATALOG` — `ModelKey` and the slug maps derive from it:

```ts
{
  key: "openai_gpt_5_7_sol",
  provider: "openai",
  modelId: "gpt-5.7-sol",
  displayName: "GPT 5.7 Sol Pro",
  enabled: true,
  slug: "gpt-5-7-sol",
  openRouterModelId: "openai/gpt-5.7-sol-pro",
}
```

`modelId` is the provider's native ID; `openRouterModelId` is the alternate route
used when the direct provider has no key or the caller explicitly selects
OpenRouter. `slug` names the build artifacts on disk
(`uploads/<prompt>/<prompt>-<slug>.json`) and is what `--model` accepts — keep it
short and stable, since renaming it orphans existing builds. Set
`forceOpenRouter: true` if there is no direct route, or `importOnly: true` for
models benchmarked through a web harness rather than an API.

`tests/unit/ai/model-catalog.test.ts` fails on duplicate keys, slugs, or model
IDs across entries.

## 2. Output ceiling and sampling

`lib/ai/modelRequestProfiles.ts`. Add an `OUTPUT_CEILINGS` group when the model
accepts more or less than the MineBench default request. One ID is enough — a
lookup on either the native or OpenRouter ID resolves through the catalog to the
other:

```ts
{ tokens: 200_000, ids: ["gpt-5.7-sol"] },
```

Add to `DEFAULT_SAMPLING_IDS` (or `DEFAULT_SAMPLING_PREFIXES` for a family) when
the provider rejects a non-default `temperature`, `top_p`, or `top_k`. Leave both
alone if the model runs on the MineBench default.

## 3. Reasoning ladder

`lib/ai/reasoningProfiles.ts` holds one `EFFORT_LADDER_RULES` table shared by the
direct route and the OpenRouter route — both descend the same ladder. Add or
extend one rule with the model's IDs (or a family prefix):

```ts
{ ids: ["gpt-5.7-sol", "openai/gpt-5.7-sol-pro"], ladder: ["max", "xhigh", "high"] },
```

Exact `ids` win over `prefixes`, and prefix rules match in array order, so a new
release's rule must sit above its broader family rule. `aliases` map accepted
override words onto ladder entries (`max: null` means "start at the head").
The direct OpenAI adapter's default ladder also resolves from this table — there
is no second copy to update.

**Claude is separate.** `lib/ai/claudeModels.ts` resolves ladder, sampling
policy, thinking mode, output ceiling, beta header, and effort env var from one
row per release, and `tests/unit/ai/claude-capabilities.test.ts` fails when a
catalogued Anthropic model has no row. Nothing is inherited from the previous
release.

## 4. Provider adapter

Only when the model's API is shaped differently from its siblings. In
`lib/ai/providers/<provider>.ts`, check whether the model belongs in the existing
predicates — for example `isResponsesOnlyModel` in `openai.ts`, or the
structured-output and beta header branches in `anthropic.ts`. Helpers with
identical semantics live in `lib/ai/providers/shared.ts`; the generic
OpenAI-compatible client is `lib/ai/providers/openaiCompatible.ts`.

A genuinely new provider needs a new adapter, dispatched from
`callDirectProvider` in `lib/ai/generateVoxelBuild.ts`.

## 5. Effort override

A model with an effort ladder gets an env var so a run can lower its effort
without a code change. Add it to `.env.example` and the override list in
`docs/local-development.md`, with a line stating the native ID, supported effort
values, the MineBench default, the output cap, and the OpenRouter fallback.

## 6. Benchmark profile

`lib/ai/modelBenchmarkProfiles.ts` builds the leaderboard popover.

- `MODEL_RUN_PARAMETERS` — required; a model missing here has no profile at all.
- `MODEL_BENCHMARK_METADATA` — the release that produced the cohort plus the
  manually tallied provider cost. These rows are research provenance and stay
  manual; do not derive them from current runtime defaults.

Everything else — average inference time, JSON size, attempt counts, output cap,
prompt cohort identity — is generated into
`lib/ai/modelBenchmarkMetrics.generated.json` and committed. Do not hand-write
those.

## 7. Test

Add one expectation record to the model's family fixture under
`tests/unit/providers/` (e.g. `openai-family.test.ts`), using the shared harness
in `tests/helpers/providerConfigHarness.ts`. Assert the numbers the model card
states — output cap, reasoning payload, absent sampling parameters, and the
fallback ladder — for both routes. This is where a wrong value from the model
card gets caught.

```bash
pnpm check   # lint, test, build
```

## 8. Generate and publish

```bash
pnpm batch:generate --generate --model gpt-5-7-sol   # generate the 15-prompt cohort
pnpm model:publish --model gpt-5-7-sol --dry-run     # report the publish plan
pnpm model:publish --model gpt-5-7-sol               # upload, artifacts, verify, activate
```

Publication uploads the cohort, runs metadata/snapshot/stream maintenance
missing-only, verifies policy-aware artifact coverage
(`/api/admin/status?modelKey=<slug>` shows the same view), refreshes the
generated metrics, and only then activates the model. Imported models stay
staged (disabled) until verification passes, so a partial cohort never reaches
public surfaces. Real publications use `DIRECT_URL` to hold a per-model database
lock through activation; configure it as a direct or session-mode connection.
Commit and deploy `lib/ai/modelBenchmarkMetrics.generated.json` after
publication, along with any recorded cost updates in `modelBenchmarkProfiles.ts`.
The leaderboard efficiency views use these profiles automatically; models enter
each frontier once that measurement and sampled prompt votes are available.
Once a model has vote history, publication permits only
payload-identical cohort reconciliation; publish changed builds under a new
model identity or explicitly reset the vote and derived rating history first.

Provider-call telemetry fires at the adapter's outbound request boundary, so
internal effort, token-budget, rate-limit, and transport retries each count.
Configuration telemetry fires only after a provider accepts a request. Inference
timing excludes telemetry callbacks. A counter is published only once every job
in the cohort tracked it; see `docs/voxel-exec-raw-output.md` for the
raw-artifact layout.
