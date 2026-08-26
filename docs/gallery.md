# Gallery and saved generations

Gallery is MineBench's public prompt exhibition. It is deliberately separate from Arena: Gallery candidates, examples, and votes never write benchmark builds, matchups, ratings, coverage, or Arena vote counts.

## Product surfaces

- `/gallery` lists public candidates by raw vote count or publication time
- `/gallery/[publicId]` is the canonical public detail page
- `/gallery/yours` lists the signed-in account's private generation jobs and results
- Sandbox Generate uses the existing transient stream while signed out and durable jobs while signed in
- `/admin/gallery` is limited to `isMineBenchAdmin` accounts

Candidate prompts deduplicate by the exact literal text after boundary trimming. The first visible example is the cover; later examples are cursor-paginated newest first. Nicknames are optional, unique after NFKC/case/space normalization, and resolved dynamically. Each candidate and example can instead be attributed to Anonymous.

## Saved generations

Signed-in Sandbox generations are private, account-owned results. Contributing a successful result to a Gallery prompt is a separate action and does not expose the private generation record or storage identity. The durable execution and artifact boundaries are described in [Architecture](./architecture.md#saved-generation-execution).

## Moderation and retention

Public text uses a small deterministic whole-word filter. Reports reload authoritative content before recording or email. Gallery publishing suspension hides ordinary contributions without changing authentication, private generations, Arena, or Lab access. Vote blocks are a separate silent control shared by Gallery and Arena vote writes.

User-removed and admin-hidden records retain private audit metadata for 30 days. Large artifacts are deleted immediately when a generation or example is removed; failures remain marked for retry. `/api/admin/gallery/purge` runs daily in bounded batches, retries pending object deletion, removes expired credentials, and purges due metadata in foreign-key-safe order. Selected candidates and official prompt links are excluded from ordinary candidate purge.

All saved-generation and Gallery tables enable RLS without browser-facing policies and revoke table access from `PUBLIC`, `anon`, and `authenticated`. Application routes use the server-side Prisma connection and re-check ownership or current public visibility before returning artifact references.
