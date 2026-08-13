# Architecture: Data Model and Build Delivery

Three views of how MineBench stores and serves arena builds: the database
entities, the lifecycle of a build from generation to a rendered mesh, and the
decision flow that picks a delivery route per request.

## Database entities

```mermaid
erDiagram
    Model ||--o{ Build : "generates"
    Model ||--o{ ModelRankSnapshot : "rank history"
    Model ||--o{ ArenaShownJob : "impression queue"
    Prompt ||--o{ Build : "answered by"
    Prompt ||--o{ Matchup : "compared on"
    Model ||--o{ Matchup : "as A or B"
    Build ||--o{ Matchup : "as A or B"
    Matchup ||--o{ Vote : "receives"
    Vote ||--|| ArenaVoteJob : "queues"
    Model ||--o{ ArenaCoverageModelPrompt : "decisive votes"
    Prompt ||--o{ ArenaCoverageModelPrompt : ""
    Model ||--o{ ArenaCoveragePair : "as low or high"
    Model ||--o{ ArenaCoveragePairPrompt : "as low or high"

    Model {
        string key UK
        string slug "derived from catalog"
        boolean enabled "activation boundary"
        float eloRating
        float glickoRd
        float conservativeRating
        int shownCount
    }
    Prompt {
        string text
        boolean active "benchmark cohort or imported custom"
    }
    Build {
        int gridSize
        string palette
        string mode
        json voxelData "inline payload, small builds only"
        string voxelStoragePath "canonical gzip payload in storage"
        string voxelSha256 "content checksum, addresses artifacts"
        json arenaBuildHints "delivery class, variants, sizes"
        json arenaSnapshotPreview "LEGACY: leaving Postgres (Phase 2.2)"
        json arenaSnapshotFull "LEGACY: leaving Postgres (Phase 2.2)"
    }
    Vote {
        string sessionId
        string choice "A / B / TIE / BOTH_BAD"
    }
    ArenaVoteJob {
        datetime processedAt "drained by SKIP LOCKED batches"
    }
    ArenaShownJob {
        datetime processedAt "drained by SKIP LOCKED batches"
        int count
    }
```

Rating state lives on `Model` and is updated only by the vote-job drain (one
advisory-locked writer). Coverage tables hold decisive-vote tallies for
matchup sampling. Both job tables are append-then-drain queues; processed rows
older than 30 days are pruned by `pnpm arena:jobs:prune`.

## Build lifecycle

```mermaid
flowchart TD
    G["pnpm batch:generate --generate<br/>provider adapters, validation"] --> U["uploads/&lt;prompt&gt;/&lt;prompt&gt;-&lt;slug&gt;.json<br/>box/block spec + raw artifacts"]
    U --> P["pnpm model:publish --model &lt;slug&gt;"]
    P --> I["POST /api/admin/import-build<br/>expands spec, stores gzip payload,<br/>upserts Build (staged: enabled=false)"]
    I --> S[("Supabase Storage<br/>canonical build payloads")]
    P --> M["maintenance, missing-only:<br/>metadata backfill, snapshot artifacts,<br/>stream artifacts"]
    M --> A[("checksum-addressed artifacts<br/>arena-snapshot/v2-gzip<br/>arena-stream/v3-gzip")]
    P --> V{"policy-aware verification<br/>getArenaArtifactCoverage"}
    V -- incomplete --> X["hard fail, model stays disabled"]
    V -- complete --> R["metrics refresh<br/>(records promptCohortId)"]
    R --> E["activation: enabled=true<br/>arena + leaderboard caches invalidated"]
    E --> D["delivery: matchup / build / stream routes"]
    D --> W["client: gzip JSON to blocks<br/>transferable typed arrays to mesh worker<br/>meshed geometry back via transfer"]
```

A model can never reach public surfaces with a partial cohort: imports stage it
disabled and only publish verification activates it. `arena:artifacts:audit
--deep` re-validates everything end to end (fetch, decompress, parse, checksum,
signed-URL delivery).

## Delivery decision flow

```mermaid
flowchart TD
    Q["request for build variant<br/>(preview or full)"] --> C{"delivery class<br/>from arenaBuildHints"}
    C -- "inline ≤2MiB" --> IN["inlined in matchup response<br/>(adaptive mode, prepared cache or snapshot)"]
    C -- "snapshot ≤15MiB" --> SR{"signed-URL redirect<br/>available?"}
    C -- "stream-artifact" --> ST["stream route: 307 to ndjson artifact,<br/>else live-parsed ndjson stream"]
    SR -- yes --> S307["307 to immutable storage object<br/>(browser downloads directly)"]
    SR -- no --> AF{"snapshot artifact<br/>fetch (storage-first)"}
    AF -- hit --> ASRV["serve artifact bytes"]
    AF -- miss --> DB{"legacy DB snapshot<br/>columns (fallback, instrumented)"}
    DB -- hit --> DSRV["serve db snapshot<br/>(logged: must reach zero before columns drop)"]
    DB -- miss --> LP["live prepare: parse canonical payload,<br/>validate, cache, heal core metadata"]
    ST --> VOTE
    IN --> VOTE
    S307 --> VOTE
    ASRV --> VOTE
    DSRV --> VOTE
    LP --> VOTE["voting unlocks only after<br/>the full build hydrates"]
```

Artifacts are immutable and checksum-addressed, so every cache layer (CDN,
signed-URL cache, in-process body caches, client IndexedDB mesh cache) can
treat a hit as final. The DB snapshot columns are a compatibility fallback
scheduled for removal once production logs show zero fallback hits
(`arena snapshot db fallback` lines) through a full soak window.
