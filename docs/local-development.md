# MineBench Local Development

Use this guide to run MineBench locally, configure provider keys, and work on the app without digging through the top-level README.

## Prerequisites

- Node.js `18+`
- `pnpm`
- Docker (for local Postgres)

## Install Dependencies

```bash
pnpm install
```

## Create an Env File

```bash
cp .env.example .env
```

## Start the App and Database

```bash
pnpm dev:setup
```

`pnpm dev:setup` will:
- ensure `.env` exists
- build the texture atlas
- reset local Docker Postgres volume
- run Prisma migrations
- start Next.js dev server on `http://localhost:3000`

## Seed the Local Database

In a second terminal:

```bash
pnpm prompt --import
```

Then open:
- `http://localhost:3000/` (Arena)
- `http://localhost:3000/sandbox`
- `http://localhost:3000/leaderboard`

## Alternative Startup

If you do not want to reset the DB volume each time:

```bash
pnpm db:up
pnpm prisma:migrate
pnpm dev
```

## Live Generation

To generate fresh builds in `/sandbox`:

1. Open `http://localhost:3000/sandbox`
2. Switch to `Live Generate`
3. Enter either:
   - an `OpenRouter` key, or
   - provider-specific keys (OpenAI, Anthropic, Gemini, Moonshot, DeepSeek, MiniMax, xAI)
4. Pick 2 models and click `Generate`

Notes:
- Keys entered in Sandbox are stored in browser `localStorage` and sent only with that request.
- In production, `/api/generate` requires request keys unless `MINEBENCH_ALLOW_SERVER_KEYS=1`.

## Environment Variables

Copy `.env.example` to `.env` and set what you need.

### Core

- `DATABASE_URL` (required): pooled/runtime Postgres URL
- `DIRECT_URL` (required): direct Postgres URL for Prisma migrations
- `ADMIN_TOKEN` (required for `/api/admin/*`)
- `CRON_SECRET` (recommended if using Vercel Cron for `/api/admin/rank-snapshots/capture`)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (required for large build upload/download via Supabase Storage)
- `SUPABASE_STORAGE_BUCKET` (optional, default `builds`)
- `SUPABASE_STORAGE_PREFIX` (optional, default `imports`)

### Provider Keys

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_AI_API_KEY`
- `MOONSHOT_API_KEY`
- `DEEPSEEK_API_KEY`
- `MINIMAX_API_KEY`
- `XAI_API_KEY`
- `OPENROUTER_API_KEY`

### Optional Provider and Runtime Tuning

- `MINEBENCH_ALLOW_SERVER_KEYS=1` (production opt-in for server env keys in `/api/generate`)
- `ANTHROPIC_OPUS_4_7_EFFORT=low|medium|high|max`
- `ANTHROPIC_OPUS_4_6_EFFORT=low|medium|high|max`
- `ANTHROPIC_SONNET_4_6_EFFORT=low|medium|high|max` (runtime falls back automatically if provider rejects `max`)
- `ANTHROPIC_STREAM_RESPONSES=1`
- `OPENAI_STREAM_RESPONSES=1` (applies to live-delta callers; batch generation uses non-streamed Responses JSON)
- `OPENAI_USE_BACKGROUND_MODE=1` (recommended for long-running Responses jobs; defaults on for `gpt-5*` when not streaming deltas)
- `OPENAI_BACKGROUND_POLL_MS=2000` (poll interval for background mode)
- `ANTHROPIC_ENABLE_1M_CONTEXT_BETA=1`
- `ANTHROPIC_THINKING_BUDGET` (legacy/manual thinking models)
- `OPENROUTER_BASE_URL`, `MOONSHOT_BASE_URL`, `DEEPSEEK_BASE_URL`, `MINIMAX_BASE_URL`, `XAI_BASE_URL`
- `AI_DEBUG=1` (logs raw model output on failures)
- `MINEBENCH_TOOL_OUTPUT_DIR`, `MINEBENCH_TOOL_TIMEOUT_MS`, `MINEBENCH_TOOL_MAX_*` (advanced `voxel.exec` controls)

## Useful Scripts

- `pnpm dev:setup`: full local bootstrap
- `pnpm dev`: start Next.js dev server
- `pnpm build` / `pnpm start`: production build and serve
- `pnpm lint`: ESLint
- `pnpm db:up` / `pnpm db:down` / `pnpm db:reset`
- `pnpm prisma:migrate` / `pnpm prisma:dev` / `pnpm prisma:generate`
- `pnpm atlas`: rebuild texture atlas
- `pnpm prompt`: inspect or import prompt build files from `uploads/`
- `pnpm batch:generate`: batch-generate and or upload build files
- `pnpm elo:reset --yes [--keep-history]`: reset arena rating and leaderboard stats
- `pnpm arena:load --base-url http://localhost:3000 --users 12 --duration 90`: simulate concurrent arena users

## Quality Checks

- `pnpm lint` for static checks
- no automated test suite is configured yet

## Arena Load Testing

Use the load harness to reproduce the real arena path under concurrency:

1. fetch `/api/arena/matchup?payload=adaptive`
2. wait for both full builds to finish loading
3. submit `/api/arena/vote`
4. repeat with separate session cookies per virtual user

Example runs:

```bash
pnpm arena:load --base-url http://localhost:3000 --users 12 --duration 90
pnpm arena:load --base-url https://your-preview-url.vercel.app --users 16 --duration 120
```

Useful flags:

- `--payload adaptive|inline|shell`
- `--prompt-id` with a seeded prompt id if you want to pin the run to one prompt
- `--think-ms 150`
- `--matchup-timeout-ms 12000`
- `--vote-timeout-ms 12000`
- `--build-timeout-ms 35000`

The summary includes:

- round, matchup, vote, and full-hydration latency percentiles
- timeout and error counts by stage
- `Server-Timing` breakdowns from matchup, vote, and build responses
- build source counts so you can see whether full hydration came from artifacts, live streams, or snapshot fallback

For the most realistic production test:

- point `--base-url` at the deployed preview or production URL
- make sure the deployment is using the pooled runtime `DATABASE_URL`
- precompute large build artifacts before the run so you measure the intended fast path

## Project Structure

```text
assets/             source texture pack and other build inputs
app/                Next.js App Router pages and API routes
components/         UI and voxel viewer components
lib/ai/             generation pipeline and provider adapters
lib/arena/          matchup sampling and rating logic
lib/blocks/         palette and texture atlas mapping
lib/voxel/          voxel types, validation, mesh helpers
prisma/             schema and migrations
scripts/            setup, import, generation, maintenance utilities
uploads/            local build JSON files and prompt folders
```

## Troubleshooting

- `No seeded prompts found` on Arena:
  - Run `pnpm prompt --import` or use `/api/admin/seed`.
- `Missing ADMIN_TOKEN` or `Invalid token` on admin endpoints:
  - Set `ADMIN_TOKEN` in `.env` and send `Authorization: Bearer $ADMIN_TOKEN`.
- `/api/generate` returns no-key error in production:
  - send `providerKeys` from client or set `MINEBENCH_ALLOW_SERVER_KEYS=1`.
- large upload fails and script falls back to direct API body upload:
  - set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and optionally `SUPABASE_STORAGE_BUCKET`.
- DB connection errors:
  - ensure Docker is running, `DATABASE_URL` and `DIRECT_URL` are valid, then run `pnpm db:up`.
- missing or broken block textures:
  - run `pnpm atlas` to rebuild `public/textures/atlas.png` from `assets/texture-pack/`.
