# Versioning

MineBench follows [semver](https://semver.org/) with project-specific rules for what each component represents.

## Schema

- **MAJOR (`X.0.0`)** — methodology change or full visual redesign
  - new scoring metric or voting system
  - full frontend redesign
  - new benchmark category (e.g. adding or removing a prompt class)
- **MINOR (`1.X.0`)** — new model or new feature
  - new model added to the benchmark
  - new feature shipped (GIF export, lateral nav, model detail page, new prompt)
- **PATCH (`1.1.X`)** — bug fixes or small polish
  - UI tweaks, spacing, broken links, copy changes
  - small UX adjustments that do not add new capability

## Worked examples

- **v1.0.0** — initial public release bundling four model additions (Grok 4.20, Kimi K2.6, Opus 4.7, GLM 5.1), the frontend redesign, GIF export, and lateral navigation.
- **v1.1.0** — hypothetical next model added (e.g. DeepSeek V4). Single new model = MINOR.
- **v1.1.1** — hypothetical leaderboard sort fix. No new capability = PATCH.
- **v2.0.0** — hypothetical replacement of the Glicko-style scoring system, or a second full redesign.

## Release workflow

Releases are authored manually via `gh release create --generate-notes` so the "What's Changed" section auto-populates with merged PRs since the prior tag. See [`RELEASE_TEMPLATE.md`](./RELEASE_TEMPLATE.md) for the body template.

Releases are text-only — no attached GIFs or screenshots. Visual comparisons live on [minebench.ai](https://minebench.ai) and in Reddit announcement threads.
