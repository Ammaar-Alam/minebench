# MineBench

MineBench is a web-based benchmark for comparing AI models on **Minecraft-style voxel builds**.

It has two modes:

- **Arena (`/`)**: curated prompts, head-to-head A/B builds, global Elo rankings
- **Sandbox (`/sandbox`)**: enter any prompt, pick models/settings, stream results as they finish

## Tech

- Next.js (App Router) + TypeScript + Tailwind
- Three.js voxel renderer (Minecraft-like: face culling + nearest-neighbor textures)
- Prisma + Vercel Postgres (Arena + Elo persistence)

## Local dev

```bash
pnpm install
pnpm dev:setup
```

Prisma reads `.env` (not `.env.local`), so make sure `DATABASE_URL` is set there.

Copy `.env.example` to `.env` and set:

- `DATABASE_URL` (Postgres connection string; use Supabase pooler on Vercel)
- `DIRECT_URL` (direct Postgres connection string; used for Prisma migrations)
- `ADMIN_TOKEN` (protects `/api/admin/*`)
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_AI_API_KEY`

### Using Supabase (Vercel)

If you're using Supabase Postgres, set:

- `DATABASE_URL` to the Supabase **Connection pooler** connection string
- `DIRECT_URL` to the Supabase **Direct connection** connection string
- Make sure the pooler URL includes `pgbouncer=true` (Prisma needs this for transaction pooling)

### No DB / no keys?

- You can run `pnpm dev` and use `http://localhost:3000/sandbox` without a database.
- The Arena (`/`) + leaderboard require a working `DATABASE_URL` and seeded builds.

## Seeding curated prompts (Arena)

After setting env vars, run the admin seed route:

```bash
# Prompts + model catalog only (no AI calls)
curl -X POST "http://localhost:3000/api/admin/seed?generateBuilds=0" -H "Authorization: Bearer $ADMIN_TOKEN"

# Full seed (generates missing builds; repeat until done)
curl -X POST "http://localhost:3000/api/admin/seed" -H "Authorization: Bearer $ADMIN_TOKEN"
```

Repeat until it reports seeding is complete (it seeds in small batches to avoid timeouts).

## One-command dev

```bash
pnpm dev:setup
```

`pnpm dev:setup` recreates the local Docker Postgres volume (drops local data). If you want to keep your local DB state, use `pnpm db:up` instead.

## Texture attribution

This repo includes the Faithful texture pack at `faithful-32x-1.21.11`.
See `faithful-32x-1.21.11/LICENSE.txt` for license details.
