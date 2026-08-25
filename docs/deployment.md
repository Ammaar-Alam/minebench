# MineBench Deployment

MineBench works well with Vercel and Supabase Postgres.

## Recommended Environment

- `DATABASE_URL`: Supabase pooler URL (`pgbouncer=true`)
- `DIRECT_URL`: Supabase direct URL for Prisma migrations
- `SUPABASE_URL`: your Supabase project URL
- `NEXT_PUBLIC_SUPABASE_URL`: the same Supabase project URL, used by SSR Auth
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: Supabase publishable key for SSR Auth
- `SUPABASE_SECRET_KEY`: preferred server-only key for admin operations
- `SUPABASE_SERVICE_ROLE_KEY`: server-only key
- `SUPABASE_STORAGE_BUCKET`: private bucket for build payload objects (default `builds`)
- `MINEBENCH_SITE_URL`: the exact deployment origin used in Auth redirects
- `CONTACT_SMTP_PASSWORD`: Google Workspace app password for `support@minebench.ai`

Public account and provider provisioning is documented in
[`docs/public-authentication.md`](public-authentication.md).

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
- `SUPABASE_SECRET_KEY` must stay server-side only. Never expose either server key through a
  `NEXT_PUBLIC_` variable.
- `CONTACT_SMTP_PASSWORD` must stay server-side only and should be configured for both Preview and Production before testing the contact form.
- Build APIs support records stored as inline JSON or storage pointers.
