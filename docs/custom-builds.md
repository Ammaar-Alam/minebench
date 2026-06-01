# Custom Builds

Custom Builds add a dedicated way to generate MineBench builds without touching Arena rankings. The feature has two entrypoints:

- **Hosted API endpoints** for creating custom build jobs, watching status/events, downloading generated JSON, and requesting GLB/STL/Schem exports.
- **Local CLI tooling** for developers who want a faster repo-local path to generate, validate, export, and save custom builds from a terminal.

Use the API when another app, script, or hosted MineBench session should request a generation and get a private status/download link back. Use the CLI when you are working from a repo checkout and want artifacts written directly to disk.

Custom Builds reuse MineBench generation, validation, viewer, storage, and export code, but they do not write to `Build`, `Prompt`, `Matchup`, `Vote`, model ranking, or leaderboard tables. Prompts and generated outputs are stored behind private links, and public stats are count-only.

## What You Can Call

The main API flow is:

1. `POST /api/custom-builds` with a prompt, model, grid size, palette, and provider key.
2. Read the returned custom build id and private `/custom/$CUSTOM_BUILD_ID` page URL.
3. Poll `GET /api/custom-builds/$CUSTOM_BUILD_ID` or reconnect to `GET /api/custom-builds/$CUSTOM_BUILD_ID/events`.
4. Download JSON from `GET /api/custom-builds/$CUSTOM_BUILD_ID/artifacts/json`.
5. Request optional exports with `POST /api/custom-builds/$CUSTOM_BUILD_ID/exports`, then download `glb`, `stl`, or `schem` artifacts.

The same generation pipeline is available locally with `pnpm custom:build`, which can either call a provider from a prompt or export an existing MineBench JSON file.

## Hosted Flow

1. Open `/sandbox`.
2. Enter a prompt, choose a model, and provide a provider key.
3. MineBench creates a private custom build and returns a `/custom/$CUSTOM_BUILD_ID` page immediately.
4. A worker processes generation outside the Vercel request path.
5. The private page reconnects to persisted events, renders a preview, and exposes JSON/export downloads.

The old `/api/generate` stream remains the default Sandbox path. Set `CUSTOM_BUILDS_ENABLED=1` to enable the hosted custom build endpoints. Set `NEXT_PUBLIC_CUSTOM_BUILDS_DURABLE=1` only after the custom build worker, encryption secret, and storage credentials are configured.

Provider keys are user-supplied by default. The web route encrypts a TTL-bound credential for queued/running jobs and deletes it when the generation reaches a terminal state. Plaintext provider keys are not stored.

## Local CLI

Use the CLI when working from a repo clone and writing files locally. It is the shortest path for developer custom builds because it does not require clicking through the Sandbox UI or wiring up HTTP calls:

```bash
pnpm custom:build --prompt "a small stone bridge" --model openai_gpt_5_4_mini
```

The command writes:

- `build.json`
- `build.json.gz`
- `metadata.json`
- optional `build.glb`, `build.stl`, and `build.schem`
- `raw-output.txt` for generated model runs

By default, output goes under `custom-builds/`. Choose a directory explicitly:

```bash
pnpm custom:build \
  --prompt-file prompt.txt \
  --model anthropic_claude_4_8_opus \
  --prefer-openrouter \
  --out custom-builds/stone-arch
```

Export an existing MineBench JSON file without model calls:

```bash
pnpm custom:build \
  --json uploads/castle/castle-gpt-5-4-mini.json \
  --grid-size 256 \
  --exports glb,schem \
  --out custom-builds/castle-export
```

Generation uses configured provider env vars such as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_AI_API_KEY`.

## API Endpoints

These endpoints let scripts and integrations start custom build generations directly. The create route returns immediately with an id, status URL, event stream URL, artifact URL, export URL, and private page URL while the worker does the model call in the background.

Create a custom build:

```bash
export OPENROUTER_API_KEY="$(security find-generic-password -a "$USER" -s openrouter-api-key -w)"

jq -nc \
  --arg prompt "a small stone bridge" \
  --arg key "$OPENROUTER_API_KEY" \
  '{
    prompt: $prompt,
    gridSize: 256,
    palette: "simple",
    model: { kind: "catalog", modelKey: "openai_gpt_5_4_mini" },
    providerKeys: { openrouter: $key },
    preferOpenRouter: true
  }' \
  | curl -sS -X POST "http://localhost:3000/api/custom-builds" \
      -H "Content-Type: application/json" \
      --data-binary @- \
  | tee custom-build-response.json
```

Save the returned id:

```bash
CUSTOM_BUILD_ID="$(jq -r '.id' custom-build-response.json)"
```

Poll status:

```bash
curl -sS "http://localhost:3000/api/custom-builds/$CUSTOM_BUILD_ID"
```

Reconnect to events:

```bash
curl -N "http://localhost:3000/api/custom-builds/$CUSTOM_BUILD_ID/events"
```

Download normalized JSON:

```bash
curl -L "http://localhost:3000/api/custom-builds/$CUSTOM_BUILD_ID/artifacts/json" \
  -o "minebench-$CUSTOM_BUILD_ID.json.gz"
```

Request exports after generation succeeds:

```bash
curl -sS -X POST "http://localhost:3000/api/custom-builds/$CUSTOM_BUILD_ID/exports" \
  -H "Content-Type: application/json" \
  --data '{"formats":["glb","stl","schem"]}'
```

Download exports:

```bash
curl -L "http://localhost:3000/api/custom-builds/$CUSTOM_BUILD_ID/artifacts/glb" -o "minebench-$CUSTOM_BUILD_ID.glb"
curl -L "http://localhost:3000/api/custom-builds/$CUSTOM_BUILD_ID/artifacts/stl" -o "minebench-$CUSTOM_BUILD_ID.stl"
curl -L "http://localhost:3000/api/custom-builds/$CUSTOM_BUILD_ID/artifacts/schem" -o "minebench-$CUSTOM_BUILD_ID.schem"
```

Count-only stats:

```bash
curl -sS "http://localhost:3000/api/custom-builds/stats"
```

## Routes

- `POST /api/custom-builds`: create and enqueue a custom build.
- `GET /api/custom-builds/$CUSTOM_BUILD_ID`: status, artifacts, exports, and errors.
- `GET /api/custom-builds/$CUSTOM_BUILD_ID/events`: persisted SSE events with `Last-Event-ID` and `?after=` replay.
- `GET /api/custom-builds/$CUSTOM_BUILD_ID/artifacts`: artifact list.
- `GET /api/custom-builds/$CUSTOM_BUILD_ID/artifacts/$FORMAT`: private signed redirect or local file response.
- `POST /api/custom-builds/$CUSTOM_BUILD_ID/exports`: enqueue GLB/STL/Schem export jobs.
- `GET /api/custom-builds/stats`: aggregate counts only.
- `GET /custom/$CUSTOM_BUILD_ID`: private page for status, preview, downloads, and export actions.

## Worker

Run workers outside Vercel:

```bash
pnpm custom:worker
```

The worker uses DB leases with stale-lease recovery. Start with one worker and one active job while traffic is low.

Recommended production shape:

- Web/API routes on Vercel.
- One always-on Node worker on EC2 or ECS Fargate.
- Supabase private Storage bucket for custom artifacts.
- Supabase Postgres for metadata, events, jobs, and count-only stats.

Minimum worker env:

| Variable | Source |
| --- | --- |
| `DATABASE_URL` | Supabase pooled/runtime Postgres connection string |
| `DIRECT_URL` | Supabase direct Postgres connection string for Prisma |
| `CUSTOM_BUILDS_ENABLED` | Set to `1` in the deployment environment |
| `CUSTOM_BUILD_KEY_ENCRYPTION_SECRET` | Secret manager or local `.env` |
| `CUSTOM_BUILD_STORAGE_BUCKET` | Private Supabase Storage bucket name |
| `SUPABASE_URL` | Supabase project API URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |

Use real deployment secrets from the provider dashboard or secret store. Do not commit those values.

### EC2/systemd

For an EC2 checkout at `/srv/minebench`, create `/etc/systemd/system/minebench-custom-worker.service`:

```ini
[Unit]
Description=MineBench custom build worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/minebench
EnvironmentFile=/etc/minebench/custom-build-worker.env
ExecStart=/usr/bin/env pnpm custom:worker
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now minebench-custom-worker
sudo journalctl -u minebench-custom-worker -f
```

### ECS/Fargate

Use the same app image as the web app and override the command:

```text
pnpm custom:worker
```

Set desired count to `1` initially. Increase worker count only after queue depth and DB capacity justify it.

## OpenRouter Opus 4.8

OpenRouter request shaping is verified without spending model credits by `pnpm openrouter:verify`. Schema-constrained Opus 4.8 fallback requests omit unsupported parameters such as `temperature` when `provider.require_parameters` is enabled.

## Verification

Run the stubbed local flow against the Docker database:

```bash
node scripts/with-local-env.mjs pnpm custom:verify
```

The same script has an opt-in cheap model smoke path. It still writes metadata and artifacts to local verification storage, but it makes a real provider call:

```bash
CUSTOM_BUILD_SMOKE=1 \
CUSTOM_BUILD_SMOKE_PROVIDER=openrouter \
CUSTOM_BUILD_SMOKE_MODEL_KEY=openai_gpt_5_4_nano \
node scripts/with-local-env.mjs pnpm custom:verify
```

For the default OpenRouter smoke, set `OPENROUTER_API_KEY` in the shell or local env before running the command. Direct-provider smoke runs use the matching provider key env, such as `OPENAI_API_KEY` or `GOOGLE_AI_API_KEY`.

## Troubleshooting

### `Custom build credential encryption is not configured`

Set `CUSTOM_BUILD_KEY_ENCRYPTION_SECRET` in the web/API environment and worker environment. The value must be a real secret from the deployment secret store or local `.env`.

### Jobs stay queued

Confirm a worker is running and using the same database:

```bash
pnpm custom:worker
```

Check `/api/admin/status` for custom build job counts.

### Downloads fail locally

When using local filesystem storage, run the dev server with the same local storage settings used by the worker:

```bash
node scripts/with-local-env.mjs env \
  CUSTOM_BUILD_STORAGE_BUCKET=__local_fs__ \
  CUSTOM_BUILD_LOCAL_STORAGE_DIR=.custom-build-storage \
  pnpm dev
```

### Production downloads fail

Confirm `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CUSTOM_BUILD_STORAGE_BUCKET` are set in the web/API environment. The bucket should be private; API routes create time-limited signed URLs.
