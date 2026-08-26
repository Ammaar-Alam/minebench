# Gallery and saved generations

Gallery is MineBench's public prompt exhibition. It is deliberately separate from Arena: Gallery candidates, examples, and votes never write benchmark builds, matchups, ratings, coverage, or Arena vote counts.

## Product surfaces

- `/gallery` lists public candidates by raw vote count or publication time
- `/gallery/[publicId]` is the canonical public detail page
- `/gallery/yours` lists the signed-in account's private generation jobs and results
- Sandbox Generate uses the existing transient stream while signed out and durable jobs while signed in
- `/admin/gallery` is limited to `isMineBenchAdmin` accounts

Candidate prompts deduplicate by the exact literal text after boundary trimming. The first visible example is the cover; later examples are cursor-paginated newest first. Nicknames are optional, unique after NFKC/case/space normalization, and resolved dynamically. Each candidate and example can instead be attributed to Anonymous.

## Durable generation lifecycle

`POST /api/generations` creates one owned record and one queued job per selected model. Request-scoped provider credentials and custom endpoint URLs are encrypted with AES-256-GCM, bound to the generation ID, and deleted on success, failure, cancellation, or expiry. The worker is started separately:

```bash
pnpm exec tsx scripts/custom-build-worker.ts
```

Successful jobs store four private objects under `CUSTOM_BUILD_STORAGE_PREFIX/<publicId>/`:

- canonical normalized JSON, gzip encoded
- an MBV4 preview
- an MBV4 or MBF1 viewer artifact
- a deterministic SVG thumbnail

The canonical JSON remains the source artifact. Owner downloads redirect to a short-lived Storage URL and do not proxy large production objects through Vercel. Actual stored bytes are recorded per artifact and generation; new jobs stop at the internal per-account failsafe once retained objects reach 1 GiB.

Required runtime configuration:

- `CUSTOM_BUILD_KEY_ENCRYPTION_SECRET`
- `CUSTOM_BUILD_STORAGE_BUCKET`
- `CUSTOM_BUILD_STORAGE_PREFIX`
- Supabase URL and service-role credentials used by existing private build storage
- `VOTE_BLOCK_HMAC_SECRET`
- SMTP configuration used by the contact flow
- `CRON_SECRET` or `ADMIN_TOKEN` for scheduled purge

Run the read-only storage ownership and byte-accounting audit with:

```bash
pnpm exec tsx scripts/audit-saved-generation-artifacts.ts
pnpm exec tsx scripts/audit-saved-generation-artifacts.ts --deep
```

`--deep` checks referenced object existence and unowned objects in the configured prefix. `--limit` performs a metadata-only sample and intentionally skips orphan enumeration.

## Moderation and retention

Public text uses a small deterministic whole-word filter. Reports reload authoritative content before recording or email. Gallery publishing suspension hides ordinary contributions without changing authentication, private generations, Arena, or Lab access. Vote blocks are a separate silent control shared by Gallery and Arena vote writes.

User-removed and admin-hidden records retain private audit metadata for 30 days. Large artifacts are deleted immediately when a generation or example is removed; failures remain marked for retry. `/api/admin/gallery/purge` runs daily in bounded batches, retries pending object deletion, removes expired credentials, and purges due metadata in foreign-key-safe order. Selected candidates and official prompt links are excluded from ordinary candidate purge.

All saved-generation and Gallery tables enable RLS without browser-facing policies and revoke table access from `PUBLIC`, `anon`, and `authenticated`. Application routes use the server-side Prisma connection and re-check ownership or current public visibility before returning artifact references.
