# Adding a Model

Every surface a new model touches, in the order to edit them.

Before writing code, read the provider's model card and note four things: the
output ceiling, the reasoning or thinking levels it accepts, whether it rejects a
non-default `temperature`, and whether its API is restricted (Responses-only, a
required beta header, a fixed reasoning mode). Nearly every step below is just
recording one of those facts.

Do not copy the values from the previous release in the same family. Providers
change output caps and effort levels between minor versions, and a wrong value
here benchmarks the model on a request it never accepted.

## 1. Register the model

`lib/ai/modelCatalog.ts` is the entry point. Add the key to the `ModelKey` union
and an entry to `MODEL_CATALOG`:

```ts
{
  key: "openai_gpt_5_7_sol",
  provider: "openai",
  modelId: "gpt-5.7-sol",
  displayName: "GPT 5.7 Sol Pro",
  enabled: true,
  openRouterModelId: "openai/gpt-5.7-sol-pro",
}
```

`modelId` is the provider's native ID; `openRouterModelId` is the alternate route
used when the direct provider has no key or the caller explicitly selects
OpenRouter. Errors from a selected direct route are returned without switching
providers. Set `forceOpenRouter: true` if there is no direct route, or
`importOnly: true` for models benchmarked through a web harness rather than an
API.

`scripts/uploadsCatalog.ts` needs a matching `MODEL_SLUG` entry. The slug names
the build artifacts on disk (`uploads/<prompt>/<prompt>-<slug>.json`) and is what
`--model` accepts, so keep it short and stable — renaming it orphans existing
builds.

## 2. Output ceiling and sampling

`lib/ai/modelRequestProfiles.ts` holds both, for every provider.

Add an `OUTPUT_CEILINGS` group when the model accepts more or less than the
MineBench default request. The direct and OpenRouter ID go in the same group,
since a ceiling belongs to the model rather than the route:

```ts
{ tokens: 200_000, ids: ["gpt-5.7-sol", "openai/gpt-5.7-sol-pro"] },
```

Exact IDs are matched before `OUTPUT_CEILING_PREFIXES`, so a family entry can be
overridden by a single model. Leave both alone if the model runs on the MineBench
default.

Add to `DEFAULT_SAMPLING_IDS` (or `DEFAULT_SAMPLING_PREFIXES` for a whole family)
when the provider rejects a non-default `temperature`, `top_p`, or `top_k`.

## 3. Reasoning ladder

`lib/ai/reasoningProfiles.ts` resolves the effort ladder for both routes, highest
level first. Generation starts at the head and walks down when the provider
rejects a level. Two functions need the model: `openAiReasoningEffortAttempts`
for the direct route and `openRouterReasoningEffortAttempts` for the fallback,
plus the equivalent pair for whichever provider applies.

Order matters. A `startsWith` branch for a new version must sit above the broader
family branch, or the family branch wins and the model silently runs on the older
ladder.

**Claude is the exception.** `lib/ai/claudeModels.ts` resolves the ladder,
sampling policy, thinking mode, output ceiling, 1M beta header, and effort env var
from the model ID, covering steps 2 and 3 in one row:

```ts
"opus-5.0": {
  effortLadder: FULL_EFFORT_LADDER,
  defaultSamplingOnly: true,
  maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
  effortEnvVar: "ANTHROPIC_OPUS_5_EFFORT",
},
```

Nothing is inherited from the previous release. A model with no row resolves to no
capabilities, and `tests/unit/ai/claude-capabilities.test.ts` fails when a
catalogued Anthropic model has no row. Use `FULL_EFFORT_LADDER` or
`NO_XHIGH_LADDER` if the model matches one, otherwise spell out the levels. An
empty ladder means no adaptive effort control and needs `legacyManualThinking`.

## 4. Provider adapter

Only when the model's API is shaped differently from its siblings. In
`lib/ai/providers/<provider>.ts`, check whether the model belongs in the
existing predicates — for example `isResponsesOnlyModel` and the
`reasoning.mode=pro` branches in `openai.ts`, or the structured-output and beta
header branches in `anthropic.ts`.

`openai.ts` also carries a `defaultReasoningEffortAttempts` ladder used when the
caller passes none. It duplicates step 3 and has to be updated alongside it.
`openrouter.ts` has `defaultTextVerbosity` for models that reject
`text.verbosity`.

A genuinely new provider needs a new adapter here, following `anthropic.ts` or
`openai.ts`, dispatched from `callDirectProvider` in
`lib/ai/generateVoxelBuild.ts`.

## 5. Effort override

A model with an effort ladder gets an env var so a run can lower its effort
without a code change. Add it to `.env.example` and the override list in
`docs/local-development.md`, then add a line to that file's model notes stating
the native ID, the supported effort values, the MineBench default, the output cap,
and what the OpenRouter fallback uses.

## 6. Benchmark profile

`lib/ai/modelBenchmarkProfiles.ts` builds the leaderboard popover.

- `MODEL_RUN_PARAMETERS` — required. The popover reads this map's keys, so a model
  missing here has no profile at all.
- `MODEL_BENCHMARK_METADATA` — the release that produced the cohort, plus the
  manually tallied provider cost. When that cost covers tracked responses, record
  their count as `totalCost.attemptCount` so later reruns cannot change the cost
  denominator.
- `HISTORICAL_BENCHMARK_OUTPUT_CAPS` — only for models whose accepted cap cannot
  be recovered from a generated cohort. A model with a complete cohort resolves
  its cap from `modelBenchmarkMetrics.generated.json` and ignores this map.

Everything else — average inference time, average JSON size, attempt counts,
build count, output cap — is generated. Do not hand-write those.

## 7. Generate the cohort

```bash
pnpm batch:generate --model gpt-5-7-sol            # report missing builds
pnpm batch:generate --generate --model gpt-5-7-sol # generate them
```

Generation writes each attempt's raw response under `uploads/<prompt>/RAW/` and
records per-job counters in `uploads/.benchmark-metrics.json`. When every prompt
has a finalized build, `scripts/benchmarkMetrics.ts` rolls those counters into
`lib/ai/modelBenchmarkMetrics.generated.json`, which is committed.

Provider-call telemetry fires at the adapter's outbound request boundary, so
internal effort, token-budget, rate-limit, and transport retries each count.
Configuration telemetry fires only after a provider accepts a request and
records the settings used for that response. New adapters must forward both
callbacks from `ProviderTelemetryCallbacks`; do not infer either value from the
requested fallback ladder.

A counter is published only once every job in the cohort tracked it, so a model
benchmarked before a counter existed omits the field and the popover renders "Not
tracked" rather than a total that undercounts real history. See
`docs/voxel-exec-raw-output.md` for the raw-artifact layout.

## 8. Test

Add a provider config test under `tests/unit/providers/` modelled on
`claude-opus-5-config.test.ts` or `gpt-5-6-sol-config.test.ts`. It stubs `fetch`,
so it asserts the exact request body for both routes without network access — the
output cap, the reasoning payload, the absence of rejected sampling parameters,
and the resolved benchmark profile.

This test is where a wrong value from the model card gets caught, so assert the
numbers the card states rather than whatever the code currently produces.

```bash
pnpm check   # lint, test, build
```
