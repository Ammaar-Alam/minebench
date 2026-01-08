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
pnpm atlas
pnpm db:up
cp .env.example .env
pnpm prisma:migrate
pnpm dev
```

Prisma reads `.env` (not `.env.local`), so make sure `DATABASE_URL` is set there.

Copy `.env.example` to `.env` and set:

- `DATABASE_URL` (Vercel Postgres connection string)
- `ADMIN_TOKEN` (protects `/api/admin/*`)
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_AI_API_KEY`

### No DB / no keys?

- You can run `pnpm dev` and use `http://localhost:3000/sandbox` without a database.
- The Arena (`/`) + leaderboard require a working `DATABASE_URL` and seeded builds.

## Seeding curated prompts (Arena)

After setting env vars, run the admin seed route:

```bash
curl -X POST http://localhost:3000/api/admin/seed -H "Authorization: Bearer $ADMIN_TOKEN"
```

Repeat until it reports seeding is complete (it seeds in small batches to avoid timeouts).

## One-command dev

```bash
pnpm dev:setup
```

## Texture attribution

This repo includes the Faithful texture pack at `faithful-32x-1.21.11`.
See `faithful-32x-1.21.11/LICENSE.txt` for license details.
