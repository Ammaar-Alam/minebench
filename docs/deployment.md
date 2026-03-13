# MineBench Deployment

MineBench works well with Vercel and Supabase Postgres.

## Recommended Environment

- `DATABASE_URL`: Supabase pooler URL (`pgbouncer=true`)
- `DIRECT_URL`: Supabase direct URL for Prisma migrations
- `SUPABASE_URL`: your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: server-only key
- `SUPABASE_STORAGE_BUCKET`: private bucket for build payload objects (default `builds`)

## Rank Snapshot Scheduling

For leaderboard movement markers:

- `vercel.json` schedules `/api/admin/rank-snapshots/capture` every hour
- set `CRON_SECRET` in Vercel
- keep `ADMIN_TOKEN` available for manual and admin calls

## Supabase Storage Setup for Large Build Imports

1. Create a private bucket, for example `builds`, in Supabase Storage.
2. In Vercel project env vars, add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_STORAGE_BUCKET` (optional if `builds`)
   - `SUPABASE_STORAGE_PREFIX` (optional if `imports`)
3. Ensure `ADMIN_TOKEN` is set in Vercel.
4. Deploy the app, then run your existing upload command flow, for example `pnpm batch:generate --upload ...`.

Notes:
- `SUPABASE_SERVICE_ROLE_KEY` must stay server-side only.
- Build APIs support records stored as inline JSON or storage pointers.
