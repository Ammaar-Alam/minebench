# Adding a Model

Every surface a new model touches, in the order you should edit them. The
running example is Claude Opus 5, added as `anthropic_claude_opus_5`.

## 1. Register the model

`lib/ai/modelCatalog.ts` is the entry point. Add the key to the `ModelKey` union
and an entry to `MODEL_CATALOG`:

```ts
{
  key: "anthropic_claude_opus_5",
  provider: "anthropic",
  modelId: "claude-opus-5",
  displayName: "Claude Opus 5",
  enabled: true,
  openRouterModelId: "anthropic/claude-opus-5",
}
```

`modelId` is the provider's native ID; `openRouterModelId` is the fallback route
used when the direct provider has no key or fails. Set `forceOpenRouter: true` if
there is no direct route, or `importOnly: true` for models benchmarked through a
web harness rather than an API.

`scripts/uploadsCatalog.ts` needs a matching `MODEL_SLUG` entry. The slug names
the build artifacts on disk (`uploads/<prompt>/<prompt>-<slug>.json`) and is what
`--model` accepts, so keep it short and stable — renaming it orphans existing
builds.

## 2. Describe the request

Most models need nothing here. Reach for these only when the model differs from
the MineBench defaults.

- **Output ceiling and sampling** — `lib/ai/modelRequestProfiles.ts`. Add the
  model's IDs to an `OUTPUT_CEILINGS` group when it accepts more or less than the
  MineBench default request, and to `DEFAULT_SAMPLING_IDS` when it rejects a
  non-default `temperature`. Both the direct and OpenRouter ID go in the same
  group, since a ceiling belongs to the model rather than the route.
- **Reasoning or thinking** — `lib/ai/reasoningProfiles.ts`, which resolves the
  effort ladder and env-var override for both routes

Claude models are the exception: `lib/ai/claudeModels.ts` resolves the effort
ladder, sampling policy, thinking mode, output ceiling, the 1M beta header, and
the effort env var from the model ID, for both the direct and OpenRouter routes.
Add one row to `CLAUDE_RELEASES`:

```ts
"opus-5.0": {
  effortLadder: FULL_EFFORT_LADDER,
  defaultSamplingOnly: true,
  maxOutputTokens: MESSAGES_API_OUTPUT_MAX,
  effortEnvVar: "ANTHROPIC_OPUS_5_EFFORT",
},
```

Nothing is inherited from the previous release. A model with no row resolves to
no capabilities, and `tests/unit/ai/claude-capabilities.test.ts` fails if a
catalogued Anthropic model has no row — so the output cap and effort levels have
to come from the model card rather than from whatever the last release did.

`effortLadder` is the exact set of levels the model accepts, highest first;
generation starts at the head and walks down when the provider rejects a level.
Use `FULL_EFFORT_LADDER` or `NO_XHIGH_LADDER` if the model matches one, otherwise
spell out the levels. An empty ladder means the model has no adaptive effort
control and needs `legacyManualThinking`.

If the provider is new entirely, add an adapter under `lib/ai/providers/`
following `anthropic.ts` or `openai.ts`, then dispatch to it from
`callDirectProvider` in `lib/ai/generateVoxelBuild.ts`.

## 3. Expose the effort override

An adaptive-effort model gets an env var so a run can lower its effort without a
code change. Document it in `.env.example` and in the override list in
`docs/local-development.md`, then add a line to that file's model notes stating
the native ID, the supported effort values, the MineBench default, and the output
cap.

## 4. Publish benchmark details

`lib/ai/modelBenchmarkProfiles.ts` builds what the leaderboard popover shows.

- `MODEL_RUN_PARAMETERS` — required. The popover reads this map's keys, so a
  model missing here has no profile at all.
- `MODEL_BENCHMARK_METADATA` — the release that produced the cohort, plus the
  manually tallied provider cost.
- `HISTORICAL_BENCHMARK_OUTPUT_CAPS` — only for models whose accepted cap cannot
  be recovered from a generated cohort. A model with a complete cohort resolves
  its cap from `modelBenchmarkMetrics.generated.json` and ignores this map.

Everything else — average inference time, average JSON size, attempt counts,
build count, output cap — is generated. Do not hand-write those.

## 5. Generate the cohort

```bash
pnpm batch:generate --model opus-5           # report missing builds
pnpm batch:generate --generate --model opus-5 # generate them
```

Generation writes each attempt's raw response under `uploads/<prompt>/RAW/` and
records per-job counters in `uploads/.benchmark-metrics.json`. When every prompt
has a finalized build, `scripts/benchmarkMetrics.ts` rolls those counters into
`lib/ai/modelBenchmarkMetrics.generated.json`, which is committed.

A counter is only published once every job in the cohort tracked it, so a model
benchmarked before a counter existed omits the field and the popover renders
"Not tracked" rather than a total that undercounts real history. See
`docs/voxel-exec-raw-output.md` for the raw-artifact layout.

## 6. Test

Add a provider config test under `tests/unit/providers/` modelled on
`claude-opus-5-config.test.ts`. It stubs `fetch`, so it asserts the exact request
body for both the direct and OpenRouter routes without network access — the
output cap, the reasoning payload, the absence of rejected sampling parameters,
and the resolved benchmark profile.

```bash
pnpm check   # lint, test, build
```
