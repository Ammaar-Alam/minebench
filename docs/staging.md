# Alpha Staging Pipeline

Changes ship through an alpha environment that mirrors production — same code,
same schema, and a copy of the production data — before they are promoted.
Nothing is tested against production directly.

## Environments

| | Production | Alpha |
| --- | --- | --- |
| Git branch | `master` | `alpha` (long-lived) |
| Deployment | Vercel production | Vercel preview of the `alpha` branch |
| Database | Supabase project (main branch) | Supabase branch `alpha` |
| Storage | production bucket | alpha branch bucket, synced from prod |
| Env vars | Vercel Production env | Vercel Preview env scoped to `alpha` |

The alpha Supabase branch has its own Postgres, storage, and service-role key.
Point the branch-scoped Vercel variables (`DATABASE_URL`, `DIRECT_URL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`,
`ADMIN_TOKEN`) at it; the app needs no code awareness of which environment it
is in. Vercel crons only fire on production deployments, which is fine — the
drains also run inline from request `after()` hooks.

Local credentials for the tooling live in `.env.staging.local` (git-ignored):

```
STAGING_DIRECT_URL=            # alpha branch direct Postgres connection
STAGING_SUPABASE_URL=
STAGING_SUPABASE_SERVICE_ROLE_KEY=
# STAGING_SUPABASE_STORAGE_BUCKET= (defaults to SUPABASE_STORAGE_BUCKET)
```

## Refreshing alpha from production

```bash
pnpm staging:db:refresh --yes     # pg_dump prod -> drop + restore alpha public schema
pnpm staging:storage:sync         # copy missing bucket objects prod -> alpha
```

The DB refresh refuses to run when the staging host matches production and
always requires `--yes`. The storage sync is incremental (skip-if-exists;
`--force` re-copies, `--prefix <p>` scopes to one artifact family). Refresh
whenever a test needs current production shape — typically before validating a
migration.

## Testing a change in alpha

1. Merge the feature branch (or PR) into `alpha` and push; Vercel deploys it.
2. If the change includes migrations, apply them to the alpha DB:
   `DIRECT_URL=<staging direct url> DATABASE_URL=<staging pooled url> pnpm prisma:migrate`
3. Smoke suite against alpha (with `.env` temporarily pointed at the alpha
   branch, or the env vars inline):
   - `pnpm arena:artifacts:audit` and `pnpm arena:artifacts:audit --deep --limit 25`
   - `pnpm model:publish --model <slug> --dry-run` (publish plan resolves)
   - Browse the alpha deployment: arena matchups load and hydrate fully,
     voting works, leaderboard and model detail render.
4. Watch the alpha deployment logs for `arena metadata heal` and
   `arena snapshot db fallback` lines when validating delivery changes.

## Promotion

Alpha is always `master` plus the commits under test, so promotion is a plain
merge — the exact SHAs that were validated:

```bash
git checkout master
git merge --ff-only alpha
git push
```

Migration ordering during promotion:

- **Additive migrations** (new tables, columns, indexes): run
  `pnpm prisma:migrate` against production BEFORE the deploy goes live.
- **Destructive migrations** (dropping columns or tables the previous deploy
  still reads): deploy FIRST, confirm the new deployment is serving, then run
  `pnpm prisma:migrate`. Never drop schema a live deployment still selects.

Physical space reclamation after large column drops (`VACUUM FULL` /
pg_repack) is a separately scheduled operation with its own lock and disk
planning — do not fold it into a promotion.

## One-time provisioning

1. Supabase: create a persistent branch named `alpha` of the production
   project (Dashboard → Branches). Copy its direct/pooled connection strings
   and service-role key into `.env.staging.local` and the Vercel `alpha`
   branch env vars. Create the storage bucket if the branch does not carry it.
2. Git: `git branch alpha master && git push -u origin alpha`.
3. Vercel: Project → Settings → Environment Variables → add Preview variables
   scoped to the `alpha` branch for the database/storage/admin values above.
4. Seed data: `pnpm staging:db:refresh --yes` then `pnpm staging:storage:sync`.
