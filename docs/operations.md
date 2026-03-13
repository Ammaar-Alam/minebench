# MineBench Operations and API Reference

Use this guide for arena behavior, voxel runtime details, import workflows, and API/admin reference.

## Benchmark Behavior

### Arena Settings

- Grid size: `256`
- Palette: `simple`
- Mode: `precise`

### Matchup Sampling and Voting

- Arena matchups are sampled from pre-seeded builds only.
- Matchups are selected by lane scheduler:
  - coverage `40%`
  - contender `30%`
  - uncertainty `20%`
  - exploration `10%`
- Prompt and model eligibility is based on arena-ready builds (`gridSize=256`, `palette=simple`, `mode=precise`) with at least two enabled models per prompt.
- New models are prioritized for calibration exposure via low-coverage, high-uncertainty, and low-shownCount weighting, but there is no hard equal-vote-count guarantee.
- A session cookie (`mb_session`) is used so each session can vote once per matchup.
- Vote options: `A`, `B`, `TIE`, `BOTH_BAD`.
- Rating updates:
  - `A`, `B`, and `TIE`: Glicko-style pair update (rating, RD, volatility)
  - public leaderboard order uses conservative score: `rating - 2*RD`
  - `BOTH_BAD`: updates `bothBadCount` only and does not mutate pairwise skill rating

For formulas and worked examples, see [Arena Ranking System](./arena-ranking-system.md).

### Rate Limiting

Middleware rate limits non-admin API routes to `18 requests / 10 seconds` per `IP + path`.

## Voxel Task Format

Default behavior: all runtime model generations use `voxel.exec` tool mode.

- Models emit a tool-call envelope (`tool: voxel.exec` + JS code).
- MineBench executes that code server-side and converts it into final voxel build JSON.
- The artifact we render and store is always build JSON in `version/boxes/lines/blocks` format.

Raw tool-call example:

- [`examples/voxel-exec-tool-call-example.json`](./examples/voxel-exec-tool-call-example.json)

Full pipeline docs:

- [Voxel Exec Runtime, Conversion, and Import Workflows](./voxel-exec-raw-output.md)

Note: non-tool generation exists only as an explicit fallback or dev path, for example `pnpm batch:generate --notools`.

Models produce JSON in this schema:

```json
{
  "version": "1.0",
  "boxes": [
    { "x1": 10, "y1": 0, "z1": 10, "x2": 20, "y2": 6, "z2": 20, "type": "stone" }
  ],
  "lines": [
    { "from": { "x": 15, "y": 7, "z": 15 }, "to": { "x": 15, "y": 18, "z": 15 }, "type": "oak_log" }
  ],
  "blocks": [
    { "x": 15, "y": 19, "z": 15, "type": "glowstone" }
  ]
}
```

Validation pipeline:
- expands `boxes` and `lines`
- normalizes and drops invalid block types
- drops out-of-bounds coordinates
- deduplicates final blocks
- enforces max block limits

Current generation constraints:
- grid sizes: `64`, `256`, `512`
- minimum blocks: `200`, `500`, `800`
- max blocks: `196,608`, `2,000,000`, `4,000,000`
- minimum structural span checks for width, depth, and height

Block palettes:
- `simple` and `advanced` are defined in `lib/blocks/palettes.json`

## Seeding and Import Workflows

### Option A: Import Local JSON Files from `uploads/`

```bash
pnpm prompt
pnpm prompt --import
pnpm prompt --import --overwrite
```

Create a new prompt folder scaffold:

```bash
pnpm prompt --init --prompt arcade --text "A classic arcade cabinet with ..."
```

### Option B: Seed Curated Prompts and Generate Missing Builds via API

Set `ADMIN_TOKEN` in `.env`, restart the dev server, then:

```bash
# status
curl -sS "http://localhost:3000/api/admin/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# prompts + model catalog only (no generation)
curl -sS -X POST "http://localhost:3000/api/admin/seed?generateBuilds=0" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# dry run
curl -sS -X POST "http://localhost:3000/api/admin/seed?dryRun=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# generate missing builds in batches (repeat until done=true)
curl -sS -X POST "http://localhost:3000/api/admin/seed?batchSize=2" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# capture current leaderboard rank snapshot (hourly cadence recommended)
curl -sS -X POST "http://localhost:3000/api/admin/rank-snapshots/capture" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

At least one provider key must be configured (`OPENROUTER_API_KEY` or a direct provider key) for generation to run.

### Option C: Import External Model Output Directly

Use this to import JSON from ChatGPT web or other tools:

```bash
curl -sS -X POST "http://localhost:3000/api/admin/import-build?modelKey=openai_gpt_5_2_pro&promptText=$(node -p 'encodeURIComponent(process.argv[1])' 'A medieval stone castle')&overwrite=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-binary "@uploads/castle/castle-gpt-5-2-pro.json"
```

For large payloads in production (50MB+), use the batch uploader with Supabase Storage enabled:

```bash
pnpm batch:generate --upload --prompt castle --model gpt-5-2-pro
```

The script uploads `*.json.gz` directly to Supabase Storage and then calls `/api/admin/import-build` with a small storage reference payload.

Reference prompt template:

- [ChatGPT Web Voxel Prompt Template](./chatgpt-web-voxel-prompt.md)

## API Reference

### Public Routes

- `POST /api/generate`
  - body: `{ prompt, gridSize, palette, modelKeys, providerKeys? }`
  - response: `application/x-ndjson` stream (`hello`, `start`, `retry`, `delta`, `result`, `error`, `ping`)
- `GET /api/arena/matchup?promptId=<optional>`
- `POST /api/arena/vote`
  - body: `{ matchupId, choice }`
  - `choice`: `A | B | TIE | BOTH_BAD`
- `GET /api/arena/prompts`
- `GET /api/sandbox/benchmark?promptId=&modelA=&modelB=`
- `GET /api/leaderboard`

### Admin Routes

Bearer `ADMIN_TOKEN` required.

- `GET /api/admin/status`
- `POST /api/admin/seed?dryRun=1&generateBuilds=0&batchSize=2`
- `GET|POST /api/admin/rank-snapshots/capture?at=<optional-iso-timestamp>`
- `POST /api/admin/import-build?modelKey=...&promptId=...|promptText=...&gridSize=256&palette=simple&mode=precise&overwrite=1`
  - body can be either:
    - raw voxel JSON (legacy)
    - storage envelope: `{ "storage": { "bucket": "...", "path": "...", "encoding": "gzip" } }`

## Batch Generation Examples

```bash
# status only
pnpm batch:generate

# generate missing files
pnpm batch:generate --generate

# generate without voxel.exec tool mode
pnpm batch:generate --generate --notools

# upload existing files to production
pnpm batch:generate --upload

# generate + upload with prompt/model filters
pnpm batch:generate --generate --upload --prompt castle --model sonnet

# all options
pnpm batch:generate --help
```

Build files are written under `uploads/<prompt-slug>/`.

When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, `--upload` uses direct Supabase Storage upload plus finalize import, which is the recommended path for 100MB-scale builds.

## Database Notes

Prisma models:
- `Model`
- `Prompt`
- `Build`
- `Matchup`
- `Vote`

Prisma creates quoted PascalCase table names in Postgres.
When querying manually, use quoted identifiers, for example:

```sql
select count(*) from public."Prompt";
```
