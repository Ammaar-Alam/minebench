# Arena Regression Investigation - 2026-04-23

## Scope

Investigate the merged `fix/arena-backend-concurrency` production regression, reproduce it locally against a cloned prod database, identify the exact root cause(s), and iterate on backend/perf fixes with verification.

## Production Signals

Pre-merge `1000` users / `30s` on `https://minebench.ai`:

- `rounds_completed=572`
- `matchup_requests=855`
- `matchup_timeouts=731`
- `matchup 429=1865`
- `matchup 500=567`
- `vote_timeouts=155`

Post-merge `1000` users / `30s` on `https://minebench.ai`:

- `rounds_completed=1`
- `matchup_requests=89`
- `matchup_timeouts=2299`
- `matchup 500=2191`
- `matchup 429=100`
- `vote_timeouts=56`
- `vote 409 Unable to start a transaction in the given time=12`

Interpretation:

- This is not just a measurement change. Throughput collapsed.
- The lower `429` count does **not** imply improvement. Requests are hanging/failing before they hit the limiter often enough to produce the earlier `429` profile.

## Local Repro Setup

Working from clean worktree on merged `origin/master`:

- worktree: `/tmp/minebench-arena-regression`
- merged baseline: `99d65b0` (`Merge pull request #24 from Ammaar-Alam/fix/arena-backend-concurrency`)
- local DB path: `pnpm env:localdb && pnpm local:db:refresh`
- local runtime: `node scripts/with-local-env.mjs ./node_modules/.bin/next build`
- local server: `node scripts/with-local-env.mjs ./node_modules/.bin/next start -p 3000`

Cloned prod snapshot sizes observed during refresh:

- `Build`: `579`
- `Matchup`: `153220`
- `Vote`: `110033`
- `ArenaCoveragePairPrompt`: `10481`
- `Model`: `40`
- `Prompt`: `16`

## Local Load Results

### 10 users / 15s

- `rounds_completed=61`
- `round_failures=6`
- `matchup_requests=67`
- `matchup p95=1500.7ms`
- `vote.tx p95=515.4ms`
- Errors are already vote write conflicts:
  - `prisma.model.update()` deadlock/write conflict
  - `arenaCoverageModelPrompt.upsert()` deadlock/write conflict

### 50 users / 15s

- `rounds_completed=93`
- `round_failures=28`
- `matchup_requests=121`
- `matchup.tx p95=559.7ms`
- `vote.tx p95=3036.6ms`
- `build_total p95=13502.7ms`
- Failures still dominated by vote write conflicts.

### 100 users / 15s

- `rounds_completed=103`
- `round_failures=67`
- `matchup_requests=170`
- `matchup.tx p95=2838.1ms`
- `vote.tx p95=5527.0ms`
- `build_stream.artifact_error=4`
- Failures still dominated by vote write conflicts/upsert conflicts.

### 200 users / 15s

- `rounds_completed=38`
- `round_failures=325`
- `matchup_requests=146`
- `matchup_timeouts=116`
- `matchup avg=7802.4ms`, `p95=12325.9ms`
- `vote total p95=7189.8ms`
- New failures:
  - matchup timed out after `12000ms`
  - matchup fetch failed
  - vote `Transaction already closed`
  - vote `Unable to start a transaction in the given time`

Interpretation:

- The local knee is around `100-200` concurrent users on one process.
- Vote-path contention becomes severe before full collapse.
- By `200`, matchup timeout storms begin as a secondary effect.

## Concrete Code-Level Findings

### 1. Vote coverage updates are globally serialized

`lib/arena/coverage.ts`

- `applyDecisiveVoteCoverageUpdate()` takes `pg_advisory_xact_lock(860101)` before the coverage upserts.
- That serializes all decisive vote coverage updates behind a single global lock.
- Under burst traffic, waiting transactions still pin Prisma transaction capacity and amplify queueing.

### 2. Vote transactions are too expensive for the current contention pattern

`app/api/arena/vote/route.ts`

- Interactive `Serializable` transactions with `maxWait=750ms` and `timeout=2500ms`.
- Additional reads happen inside the transaction.
- `loadModelsForVote()` does not actually lock the hot `Model` rows.
- `withArenaWriteRetry()` retries the exact same hot conflicts, multiplying pressure.

### 3. Matchup cold path rebuilds too much process-local state

`lib/arena/coverage.ts`

- Cache TTL is only `5s`, process-local.
- Cache miss path does:
  - `Build.groupBy(...)`
  - prompt/model lookups
  - `ensureArenaCoverageTablesCurrent()`
  - full `arenaCoveragePairPrompt.findMany(...)`
- At scale-out, many workers repeat the same cold refresh independently.

### 4. Coverage drift detection sits directly on the matchup request path

`lib/arena/coverage.ts`

- `ensureArenaCoverageTablesCurrent()` runs on matchup-state refresh.
- It compares decisive `Vote.count()` against `ArenaCoveragePair.aggregate()`.
- On mismatch, it triggers `rebuildArenaCoverageTables()`, which rescans all decisive votes, deletes all coverage tables, and recreates them under the same advisory lock family.
- That is too dangerous to keep on the live cold path.

### 5. Matchup GET still performs hot write-side effects

`app/api/arena/matchup/route.ts`

- Every successful fetch inserts a `Matchup` row.
- It also increments `shownCount` on two `Model` rows.
- The sampling algorithm intentionally concentrates traffic onto under-covered and adjacent-top-band models, so the same rows get hammered.

### 6. Build eligibility query lacks a dedicated hot index

`prisma/schema.prisma`

- `Build` has:
  - `@@unique([promptId, modelId, gridSize, palette, mode])`
  - `@@index([promptId])`
  - `@@index([modelId])`
- The matchup refresh hot query filters by:
  - `gridSize`
  - `palette`
  - `mode`
  - plus enabled/active relations
- There is no dedicated index to support that exact eligibility/grouping pattern.

## Investigation Direction

Priority order:

1. Remove the global coverage update lock from decisive votes.
2. Make vote transactions cheaper and less conflict-prone.
3. Remove drift detection/rebuild from the matchup cold path.
4. Reduce or eliminate hot `shownCount` writes from matchup fetches.
5. Add a Build index for the eligibility/grouping path.
6. Re-test the local capacity curve and then re-check production-oriented behavior.

## Implemented Fixes

### Request-path / DB changes

- `app/api/arena/matchup/route.ts`
  - removed matchup-row creation from `GET /api/arena/matchup`
  - replaced DB matchup ids with signed matchup tokens
  - removed hot `shownCount` DB writes
  - now reuses prepared-build cache before querying build payload rows
- `app/api/arena/vote/route.ts`
  - removed the interactive Prisma callback transaction from the foreground vote path
  - vote request now does `matchup.createMany(skipDuplicates)` plus `vote.create({ jobs: { create: ... } })`
  - duplicate vote unique conflicts are treated as idempotent success
- `lib/arena/voteJobs.ts`
  - rating/counter work moved to a DB-backed background queue (`ArenaVoteJob`)
  - worker now uses `FOR UPDATE NOWAIT` on hot model rows
  - coverage persistence moved out of the model-lock transaction into best-effort follow-up work
  - pending-job lookup now has a partial pending-only index migration
- `lib/arena/writeRetry.ts`
  - retries now include lock-not-available / transaction-start-timeout style transient capacity errors
- `lib/arena/coverage.ts`
  - matchup-state cache TTL raised to `60s`
  - `ensureArenaCoverageTablesCurrent()` removed from the live matchup hot path
  - coverage writes switched away from the previous global advisory-lock path
  - decisive coverage model-prompt updates collapsed from two queries to one multi-row upsert
- `prisma/migrations/20260423044835_add_arena_vote_job_pending_index`
  - adds partial index on pending `ArenaVoteJob(createdAt)` where `processedAt IS NULL`

### Build delivery / cache changes

- `lib/arena/buildArtifacts.ts`
  - prepared-build cache raised from `24/180MB` to `128/600MB`
  - matchup route and build routes can now reuse cached prepared builds by `(buildId, checksum)`
- `app/api/arena/builds/[buildId]/route.ts`
  - snapshot route now hits prepared-build cache before querying/parsing the build again
- `app/api/arena/builds/[buildId]/stream/route.ts`
  - stream route now reuses cached prepared builds
  - transient artifact-sign errors no longer poison the missing-artifact cache
- `lib/arena/buildStream.ts`
  - signed artifact URL generation now has in-flight de-duplication

### Client / harness changes

- `components/arena/Arena.tsx`
  - default automatic matchup retry set back to `0`
  - full auto-detail remains disabled by default
- `scripts/load-arena.ts`
  - default matchup retry set back to `0`
  - load harness now records latency on failure paths too

## Key Mid/Late Findings

### 1. The biggest regression was the foreground vote path

After the queue/token rewrite, the old `vote 409 Unable to start a transaction` / `Transaction already closed` failures largely disappeared from the load harness output.

Evidence:

- post-fix vote path at `200` users frequently shows `vote.total` average around `240-470ms`
- later server logs stopped showing the earlier foreground vote `P2028` storm

### 2. Once votes were cheap, matchup selection itself became relatively cheap too

Shell-mode isolation run (`200` users / `15s`) showed:

- `matchup.total avg=17.2ms`
- `vote.total avg=221.6ms`
- `rounds_completed=282`

Interpretation:

- matchup sampling and vote acceptance are no longer the dominant problem once build payload prep is removed from the matchup response
- the remaining wall is build hydration and request queueing around build delivery

### 3. The strongest policy lever was shrinking the inline band

Local env experiment:

- `ARENA_INLINE_INITIAL_MAX_BYTES=10MiB` -> one representative `200`-user run only reached `137` completed rounds with `263` errors
- `ARENA_INLINE_INITIAL_MAX_BYTES=2MiB` -> representative `200`-user run reached `349` completed rounds with `111` errors

More stable later run on the final simpler policy (`2MiB` inline, `120k` preview target):

- `200` users / `15s`
- `rounds_completed=330`
- `round_failures=116`
- `matchup.total avg=305.4ms`
- `vote.total avg=276.1ms`
- errors reduced to pure timeout shape:
  - `116x matchup timed out after 12000ms`

Interpretation:

- too much build preparation was still happening on the matchup response
- pushing the default adaptive behavior closer to shell/snapshot delivery helps materially

### 4. A smaller preview target also moved the higher-concurrency knee

Local env experiment:

- `ARENA_PREVIEW_TARGET_BLOCKS=120000` with `2MiB` inline:
  - representative `300`-user run: `134` completed rounds
  - representative `400`-user run: `272` completed rounds
- `ARENA_PREVIEW_TARGET_BLOCKS=50000` with `2MiB` inline:
  - representative `300`-user run: `348` completed rounds
  - representative `400`-user run: `272` completed rounds

More detailed `300`-user result with `50k` preview target:

- `rounds_completed=348`
- `round_failures=293`
- `matchup.total avg=176.0ms`
- `vote.total avg=272.7ms`
- dominant failures:
  - `163x matchup fetch failed`
  - `112x matchup timed out after 12000ms`
  - `63x build_stream timed out after 35000ms`

Interpretation:

- the wall at `300+` is now dominated by initial build hydration, especially stream/artifact preview delivery
- a lighter first-view preview is one of the few policy levers that still materially shifts throughput

### 5. Not every plausible optimization was actually good

Tested and backed out:

- variant-specific preview delivery-class routing (trying to force huge-build previews onto snapshot instead of stream/artifact)

Why it was backed out:

- it pushed too much traffic into the snapshot path
- even after adding snapshot-route prepared-build caching, the repeated `200`-user runs were worse/noisier than the simpler policy
- the simpler policy (`2MiB` inline, same full-build delivery-class semantics) produced the more reliable capacity win

## Current Diagnosis

Current local single-process status after the validated fixes:

- `100` users: generally solid
- `200` users: materially improved and often usable
- `300` users: possible with aggressive preview policy, but not stable
- `400` users: still not stable
- `1000` users: not remotely supported on one local Next.js process with current build delivery

The remaining exact bottleneck is no longer foreground DB write contention.
It is now:

1. initial build hydration volume
2. long-running stream/artifact preview downloads
3. queueing before matchup/build handlers start under many concurrent open fetches

That means the next meaningful jump beyond the current `300-400` local ceiling likely requires one of:

- a much more aggressively optimized first-view preview format
- precomputed/cached preview artifacts delivered off the app server
- browser-faithful pacing plus less eager overlap in the real client
- production horizontal scaling / CDN help beyond what a single local process can demonstrate

## Final Pass Findings

### Root cause of the post-merge 1000-user failure

The post-merge production-shaped failure was a combination of three separate issues:

1. foreground Arena routes were no longer the main bottleneck, but the stress harness was opening too many simultaneous sockets from one Node process and reporting local transport collapse as site failures
2. vote persistence had been moved off the foreground request path, but the default cron/drain capacity was too low for 1000 active voters
3. large-build/full-artifact misses could still fall back into live build preparation, which creates exactly the wrong fan-out under cold-cache load

The final local measurements support that split:

- uncapped 1000-user local runs still fail mostly with `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT` before requests reach route handlers
- server timing during those runs stays low:
  - matchup handler p95 generally under 1ms once request queueing is excluded
  - vote transaction p95 generally below a few hundred ms, and below 100ms in the final capped pass
- inline matchup payloads are still a bad default:
  - `--payload inline`, 500 users / 15s produced only 25 completed rounds and Prisma connection-pool failures

### Fixes added in the final pass

- `scripts/load-arena.ts`
  - adds a default `--max-active-requests 64` cap so the one-process load generator no longer self-DOSes local sockets
  - keeps `--max-active-requests 0` for raw uncapped socket stress
  - adds `--ramp-ms`, including true `--ramp-ms 0`
  - separates user-visible failures from non-fatal build fallback attempts
  - records network error codes and payload-reported HTTP statuses
- `lib/arena/voteJobs.ts` and drain route
  - raises default drain capacity to `10000` jobs / `50000ms`
  - uses larger batches (`128`)
  - budgets drain batches against the write-retry worst case
- build delivery
  - preview snapshot artifact redirects are enabled by default
  - snapshot/stream artifacts get immutable cache metadata
  - full stream-artifact misses fail fast with `503 Retry-After` instead of live-preparing the full build per user
  - build preparation now receives abort signals so abandoned streams can stop storage/payload work sooner
- Arena client
  - full-detail hydration is abortable on matchup advance/unmount
  - snapshot artifact redirects are handled manually so same-origin overloads are not retried as `redirect=0`; only failed off-origin artifact fetches fall back

### Final local stress results

Command:

```bash
pnpm arena:load --base-url http://127.0.0.1:3000 --users 1000 --duration 30
```

Result file:

- `/tmp/minebench-arena-postfix7-1000-30s-defaultcap64.log`

Summary:

- `rounds_started: 5056`
- `rounds_completed: 5056`
- `votes_ok: 5056`
- `errors: 0`
- `matchup.total p95: 0.2ms`
- `vote.total p95: 40.6ms`
- `build_snapshot.total p95: 28.5ms`
- end-to-end p95s include the harness request gate:
  - `matchup p95: 3289.1ms`
  - `vote p95: 4215.8ms`
  - `build_total p95: 4356.8ms`
  - `round_total p95: 8889.7ms`

Interpretation:

- local single-process MineBench now handles the user’s 1000-user / 30s Arena command with zero user-level errors when the harness uses a browser/CDN-safe request budget
- route execution is no longer the limiting factor in the measured path
- the remaining end-to-end latency is dominated by queued build hydration and artifact transfer, not DB writes or matchup computation

### Deployment prerequisites

Before enabling this in production traffic, run the artifact jobs against the production database/storage after deploy. Locally cloned DBs can use `node scripts/with-local-env.mjs ...`; production should run the same `npx tsx` scripts with the production `DATABASE_URL`, `DIRECT_URL`, Supabase URL, and service-role key:

```bash
npx tsx scripts/backfill-arena-build-metadata.ts --all
npx tsx scripts/precompute-arena-snapshot-artifacts.ts --all
```

For production, use the real prod env rather than `.env.localdb.local`. The critical settings are:

- `ARENA_PREVIEW_TARGET_BLOCKS=3000`
- `ARENA_MATCHUP_INLINE_MAX_BYTES=0`
- `ARENA_SNAPSHOT_PREVIEW_ARTIFACT_REDIRECT_ENABLED=1`
- `ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE=1` unless production uses a separate drain worker/cron
- `ARENA_VOTE_JOB_BATCH_LIMIT=128`
- `ARENA_VOTE_JOB_DRAIN_MAX_JOBS=10000`
- `ARENA_VOTE_JOB_DRAIN_MAX_MS=50000`

The middleware rate limiter is still process-local best-effort. It is no longer needed to make the measured path pass, but if MineBench needs a strict global abuse limit across Vercel instances, add Redis/KV-backed centralized rate buckets as a separate hardening task.

## Full-Build Hydration Regression - 2026-04-23 Evening

User screenshot showed the arena rendering only sampled previews around `3,000` blocks, with full builds never replacing them even after waiting.

Root cause:

- `NEXT_PUBLIC_ARENA_FULL_AUTOFETCH_MAX_BYTES=0` was documented as the default, but the client interpreted `0` as "do not auto-upgrade to full".
- The vote lock only checked whether the initial build existed or was in `loading-initial`; a rendered preview counted as ready.
- Full `stream-artifact` misses returned fast `503` and the client never retried the same stream with `artifact=0`, so missing artifacts could leave full scenes unavailable.
- Full hydration failures were silent when a preview was already visible, and Retry only retried missing initial builds.

Fix:

- `0` now means "no auto-full cap".
- votes and keyboard vote shortcuts remain disabled while either lane still needs full hydration or is in `loading-full`.
- stuck-build auto-skip still only applies to missing initial builds, so long full hydration does not auto-skip a valid matchup.
- failed full hydration now shows `Full build stalled.` and Retry reattempts full hydration.
- stream full-build hydration now retries live streaming with `artifact=0` after the first artifact attempt fails.
- live stream fallback schedules a background artifact warmup so the next user can hit the immutable stream artifact.

Verification:

- direct route smoke for `stream-artifact` build `cmmz1vvoo001lii0448cga23c`: `468,085` full blocks streamed via live fallback in `5.7s`.
- direct route smoke for snapshot build `cmo86gk8a0007kz04yz2pgf3b`: `66,990` full blocks returned via snapshot fallback.
- browser smoke at `http://127.0.0.1:3000` showed full rendered counts (`19,892` and `266,947` blocks) instead of preview counts, with no browser warnings/errors.

## Corrected Load Harness Finding

The previous zero-error `1000`-user result was not a valid "users can vote only after full builds" measurement. `scripts/load-arena.ts` skipped hydration when a lane already had an inline preview build, so preview-only rounds could vote.

Fix:

- the harness now hydrates the full `buildRef` whenever a lane has a preview or an underfilled build.
- build hydration now validates the received block count against `fullBlockCount` / `previewBlockCount` and records `build_underfilled` if the payload is incomplete.
- build and control-plane request gates are split so one load-test process does not make vote/matchup requests wait behind long build downloads.

Corrected local `50` users / `10s`:

- `rounds_completed=98`
- `full_hydrations=172`
- `errors=1` local vote `ECONNRESET`
- `build_total p95=5775.9ms`

Corrected local `1000` users / `30s` before artifact compression:

- `rounds_completed=58`
- `full_hydrations=1491`
- `errors=1174`
- dominant failures were full-build delivery and local load-generator/server transport pressure:
  - `665x vote timeout`
  - `449x build_stream timeout`
  - `32x ECONNRESET`
- server-timing still showed route logic was not the main bottleneck:
  - `matchup.total p95=13.0ms`
  - successful `vote.total p95=2101.5ms`

Interpretation:

- once full-fidelity voting is enforced, the next bottleneck is full-build payload delivery volume.
- the old zero-error 1000-user result proved the route/control plane could be fast with previews, but it did not prove full-build user readiness.

## Artifact Compression Follow-Up

Snapshot and stream artifacts were being uploaded as raw JSON/NDJSON. Representative payload sizes:

- stream `cmmz1vvoo001lii0448cga23c`: `19.5MB` raw -> `1.49MB` gzip (`7.6%` of raw)
- snapshot `cmo86gk8a0007kz04yz2pgf3b`: `2.71MB` raw -> `196KB` gzip (`7.2%` of raw)

Fix:

- compressed artifacts use new default namespaces (`arena-snapshot/v2-gzip`, `arena-stream/v3-gzip`) so old immutable raw-object caches are not reused.
- snapshot artifact uploads now gzip payloads and set `Content-Encoding: gzip`.
- stream artifact uploads now gzip NDJSON and set `Content-Encoding: gzip`.
- Supabase signed downloads did not return `Content-Encoding` in a live one-build test, so the client and load harness also detect gzip magic bytes and decompress explicitly.
- the server-side snapshot artifact fetch path also gunzips magic-byte gzip bodies before returning JSON.
- `package.json` now exposes `pnpm arena:snapshot:precompute`.

Operational note:

- one representative build (`cmo9hkxki001djv04yn14ud95`) was uploaded compressed to validate storage behavior, then restored to raw JSON/NDJSON so production cannot serve compressed artifacts before this PR deploys.

Updated production artifact prerequisites after deploy:

```bash
npx tsx scripts/backfill-arena-build-metadata.ts --all
npx tsx scripts/precompute-arena-snapshot-artifacts.ts --all
npx tsx scripts/precompute-arena-stream-artifacts.ts --all
```

Those jobs should be run against the real production DB and storage env so compressed immutable artifacts are generated in the new gzip namespaces.

The precompute shell must match the deployed runtime policy env exactly:

- `ARENA_INLINE_INITIAL_MAX_BYTES`
- `ARENA_SNAPSHOT_MAX_BYTES`
- `ARENA_ARTIFACT_MIN_BYTES`
- `ARENA_PREVIEW_TRIGGER_BYTES`
- `ARENA_PREVIEW_TARGET_BLOCKS`
- `ARENA_SNAPSHOT_ARTIFACT_PREFIX`
- `ARENA_STREAM_ARTIFACT_PREFIX`
- artifact bucket/env values

Also verify Supabase Storage CORS permits signed artifact `GET` requests from `https://minebench.ai`; otherwise the client will fall back to same-origin live/snapshot hydration instead of using off-origin artifacts.

## Final Verification After Audit Fixes

Validation commands:

- `pnpm exec tsc --pretty false --noEmit --project tsconfig.json`
- `pnpm lint`
- `pnpm build`
- `git diff --check`

Browser verification:

- local Arena showed disabled vote controls while full hydration was active.
- after hydration, the same matchup rendered complete scenes with full block counts, e.g. `66,990` vs `3,597` blocks.
- Playwright console check reported `0` errors and `0` warnings.

Corrected local `50` users / `10s` after modeling preview-then-full hydration:

- `rounds_completed=107`
- `full_hydrations=331`
- `errors=0`
- `build_total p95=4489.1ms`
- `vote.total p95=177.9ms`

Corrected local `1000` users / `30s` with default `64` build / `128` control gates before full gzip precompute:

- `rounds_completed=1415`
- `full_hydrations=2838`
- `errors=7` local vote `ECONNRESET`
- `matchup.total p95=38.9ms`
- `vote.total p95=263.6ms`
- `build_total p95=53053.8ms`

Interpretation:

- the foreground matchup/vote backend is no longer the blocker.
- the remaining 1000-user latency is full-build artifact transfer/queueing, which should improve materially only after the production gzip artifact precompute runs in the new artifact namespaces.
- increasing local build concurrency to `128` made results worse on a single dev server, confirming that local transport/storage pressure, not route CPU, is the current ceiling.

## Follow-Up: Full-Scene UX Regression Fix

A later browser repro showed the exact user-visible failure: Arena lanes displayed roughly `3,000` sampled blocks and stayed incomplete for minutes.

Additional fixes:

- removed the positive-byte-cap behavior from auto full hydration; because voting now requires full builds, every preview lane must attempt full hydration.
- replaced the permanent "full hydration failed" skip set with capped retry/backoff (`NEXT_PUBLIC_ARENA_FULL_HYDRATION_RETRY_BASE_MS`, `NEXT_PUBLIC_ARENA_FULL_HYDRATION_RETRY_MAX_MS`), so transient artifact/signing failures cannot leave a lane stuck forever.
- reset viewer readiness whenever a hydrated/cached/progressive build replaces the current lane build, so voting cannot unlock until the full mesh has actually been placed.
- persisted prepared build metadata during live stream fallback, preventing artifacts warmed under a computed checksum from becoming undiscoverable by later signed-URL lookups.
- made the load harness mirror the browser fallback path: artifact stream -> `artifact=0` live stream -> snapshot only when allowed.
- moved load-test timeouts to start after the client request gate is acquired, and records `*_queue` timings separately so harness queueing is not misreported as backend latency.
- full `inline` builds now also redirect to precomputed gzip snapshot artifacts; previously only `snapshot` full builds redirected, so many multi-MB inline full builds were still serialized through Next.js.
- full snapshot artifact redirect misses now return a stream-fallback `503` instead of falling back to large same-origin JSON responses.
- matchup responses warm full-build signed artifact URLs in `after()` so full hydration is less likely to pay signing latency on the critical path.

Browser verification:

- fresh local Arena load showed Build A blocked at `Retrieving build 1%` with vote buttons disabled while Build B showed a complete `3,597`-block full scene.
- after waiting, Build A replaced the partial lane with the complete `66,990`-block full scene and voting unlocked.
- fresh Playwright console check reported `0` errors and `0` warnings.

Post-fix local `50` users / `10s` full-fidelity run after redirecting full inline builds:

- `rounds_completed=106`
- `votes_ok=106`
- `full_hydrations=335`
- `errors=0`
- `build_total p95=5829.3ms`
- `vote.total p95=113.6ms`

Post-fix local `1000` users / `10s` with `256` build/control gates:

- `rounds_completed=222`
- `full_hydrations=2690`
- `errors=815`
- dominant failures were local transport saturation, not successful route CPU:
  - `203x build_stream ETIMEDOUT connect 127.0.0.1:3000`
  - `161x matchup timed out after 12000ms`
  - `319x vote timed out after 12000ms`
- successful route timings remained bounded:
  - `matchup.total p95=1062.2ms`
  - `vote.total p95=953.6ms`

Interpretation:

- The full-scene voting regression is fixed locally: users cannot vote on partial previews, and full lanes retry instead of freezing.
- A single local Next dev server plus one load-generator process still does not prove 1000 fully hydrated concurrent users. The current 1000-user local failures are dominated by local TCP/connect timeouts and full-build transfer pressure.
- Production capacity still requires a real deployment run after compressed artifact precompute, with either distributed source IPs or a temporary capacity-test bypass for one-IP guardrails.
