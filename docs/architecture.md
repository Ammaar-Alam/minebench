# Architecture

MineBench keeps benchmark evidence separate from the optimized data sent to the
viewer. A model's source JSON remains the reproducible record used for metrics,
while validated builds are compiled into compact, immutable render artifacts.

## System map

```mermaid
flowchart LR
    MODEL["Model provider"] --> GEN["Generation + voxel.exec"]
    GEN --> SOURCE["Source build JSON"]

    SOURCE --> METRICS["Benchmark metrics<br/>original bytes + primitive usage"]
    SOURCE --> IMPORT["Import + validation<br/>expand primitives, normalize,<br/>bounds-check, deduplicate"]

    IMPORT --> DB[("Postgres<br/>models, prompts, build metadata,<br/>ratings, votes, storage pointers")]
    IMPORT --> RAW[("Supabase Storage<br/>gzip source JSON")]
    IMPORT --> PREP["Arena preparation<br/>render filtering + preview"]
    PREP --> ARTIFACTS[("Supabase Storage<br/>MBV4 + MBF1 artifacts")]
    ARTIFACTS --> COVERAGE["Artifact coverage audit"]
    COVERAGE --> ARENA["Arena, Sandbox,<br/>Leaderboard"]
    ARENA --> VIEWER["Decode → mesh worker<br/>→ Three.js → first frame"]
```

The source and render paths intentionally diverge after import. Expanding a
`box` or `line`, removing an invalid block, or filtering hidden render data does
not rewrite the original model output or its benchmark metrics.

## Build representations

| Representation | Role | Contents |
| --- | --- | --- |
| Source JSON | Benchmark record and reprocessing source | `blocks`, `boxes`, and `lines` exactly as produced or imported |
| MBV4 | Compact validated block data | Palette names plus packed coordinates and palette indices |
| MBA4 | Arena delivery container for MBV4 | Small response metadata followed by an MBV4 body |
| MBF1 | Pre-meshed facts for large full builds | MBV4 blocks, visible-face masks, and packed ambient-occlusion levels |

The stored `.mbv4` arena object is an MBA4 container whose block body uses
MBV4. MBF1 is used for full builds with at least 150,000 validated renderable
blocks. It moves face visibility and ambient-occlusion work out of the browser's
critical path while preserving the same final Three.js geometry contract.

Gzip wraps source and derived artifacts in Storage and over the network; it is
transport compression, not another build representation.

## Import and publication

```mermaid
flowchart TD
    FILE["uploads/&lt;prompt&gt;/&lt;build&gt;.json"] --> VALIDATE["Validate source<br/>and count expanded blocks"]
    VALIDATE --> UPLOAD["Upload source JSON.gz"]
    UPLOAD --> ROW["Upsert Build<br/>source checksum, byte sizes,<br/>block count, storage pointer"]
    ROW --> PREPARE["Prepare render build<br/>and surface preview"]

    PREPARE --> V4["MBA4 / MBV4<br/>preview when needed + full"]
    PREPARE --> SIZE{"Full renderable blocks<br/>≥ 150,000?"}
    SIZE -- yes --> FACTS["MBF1 full<br/>blocks + visibility + AO"]
    SIZE -- no --> V4

    V4 --> STORE[("Checksum-addressed artifacts")]
    FACTS --> STORE
    STORE --> AUDIT{"Required artifacts present<br/>and valid?"}
    AUDIT -- no --> STOP["Publication stops"]
    AUDIT -- yes --> ENABLE["Enable model<br/>and invalidate caches"]
```

`pnpm model:publish` coordinates import, missing-only artifact generation,
coverage verification, metric refresh, and activation. The same native artifact
maintenance runs when new builds are imported, so future builds do not require
a separate MBF1 migration.

Derived objects are immutable and checksum-addressed. `ArenaBuildArtifact`
rows record which build owns each Storage object so lifecycle cleanup can remove
unreferenced artifacts without guessing from path names.

## Saved generation execution

```mermaid
flowchart LR
    CLIENT["Signed-in Sandbox"] --> WEB["Web route<br/>validate + enqueue"]
    WEB --> QUEUE[("Postgres<br/>generation + durable job")]
    QUEUE --> WORKER["Supervised worker<br/>claim + renew lease"]
    WORKER --> PROVIDER["Selected model provider"]
    PROVIDER --> WORKER
    WORKER --> CANONICAL[("Private Storage<br/>canonical JSON")]
    CANONICAL --> DERIVED["Validated preview,<br/>viewer, and thumbnail artifacts"]
    DERIVED --> STORAGE[("Private Storage<br/>derived artifacts")]
    WORKER --> QUEUE
    QUEUE --> WEB
    WEB --> CLIENT
```

The web request returns after enqueueing and never depends on a long-running
provider call. A separately supervised worker targets one deployment
environment, claims one job at a time with a renewable database lease, and
records progress for browser polling. If a worker loses its lease, it stops
writing; another process can recover stale work. Retries resume from an already
stored canonical artifact rather than invoking the provider twice.

Provider credentials belong to a single request. They are encrypted, bound to
the saved generation, and removed after success, terminal failure,
cancellation, or expiry. The canonical JSON is the recovery source of truth;
preview and viewer formats are derived from it. Account-owned downloads use
short-lived object access instead of proxying large files through the web
process.

## Arena delivery and rendering

```mermaid
flowchart TD
    MATCHUP["Matchup shell<br/>blind refs + load hints"] --> INITIAL["Initial variant request<br/>preview or full"]
    MATCHUP --> FULL["Authoritative full request<br/>format=mbf1"]

    INITIAL --> ROUTE["Build route"]
    FULL --> ROUTE
    ROUTE --> TOKEN["Validate blind token<br/>and resolve artifact"]
    TOKEN --> CHOOSE{"Full build<br/>≥ 150,000 blocks?"}

    CHOOSE -- no --> MBA4["MBA4 / MBV4"]
    CHOOSE -- yes --> MBF1["Identity-free MBF1"]

    MBA4 --> DECODE["Decode to packed blocks"]
    MBF1 --> FACTDECODE["Decode blocks + mesh facts"]

    DECODE --> WORKER["Priority mesh worker<br/>spatial lookup, visibility, AO"]
    FACTDECODE --> FASTWORKER["Priority mesh worker<br/>expand supplied visibility + AO"]

    WORKER --> GEOMETRY["Shared mesh payload<br/>materials, vertices, indices"]
    FASTWORKER --> GEOMETRY
    GEOMETRY --> THREE["Three.js group + camera fit"]
    THREE --> FRAME["First rendered frame"]
    FRAME --> REVEAL["Reveal animation"]
```

Arena refs do not expose the canonical build identity before voting. MBF1 has
no embedded build ID or checksum, so its stored gzip body can pass through the
private build route unchanged. Smaller MBA4 responses are rewritten to the
blind request identity before delivery.

The two-worker mesh pool prioritizes currently visible lanes. MBF1 skips the
worker's spatial-table construction, hidden-face traversal, and AO neighborhood
queries; it still builds the final vertex and index buffers needed by Three.js.

## Core data model

```mermaid
erDiagram
    Model ||--o{ Build : generates
    Prompt ||--o{ Build : answers
    Build ||--o{ ArenaBuildArtifact : owns
    Prompt ||--o{ Matchup : selects
    Model ||--o{ Matchup : competes
    Build ||--o{ Matchup : renders
    Matchup ||--o{ Vote : receives
    User o|--o{ Vote : owns
    Vote ||--o{ ArenaVoteJob : queues
    Model ||--o{ ModelRankSnapshot : records

    Build {
        string id PK
        int gridSize
        string palette
        int blockCount
        string voxelStoragePath
        int voxelByteSize
        int voxelCompressedByteSize
        string voxelSha256
        json arenaBuildHints
    }
    ArenaBuildArtifact {
        string buildId FK
        string bucket
        string path
    }
    Matchup {
        string id PK
        string promptId FK
        string buildAId FK
        string buildBId FK
        string samplingLane
    }
    User {
        string id PK
    }
    Vote {
        string matchupId FK
        string userId FK
        string sessionId
        string choice
    }
```

Postgres contains relational state and payload metadata, not large render
artifacts. Supabase Storage contains the source JSON and derived binary objects.
Vercel route handlers own sampling, blind-token validation, artifact resolution,
and response observability; the browser owns decoding, geometry construction,
and rendering.

Public votes remain valid without an account and use the browser session as their
duplicate-vote boundary. A signed-in vote can also have an optional `User` owner;
sign-in claims unowned public votes from the same session. Private-evaluation
votes are never assigned to public accounts. Deleting an account clears vote
ownership while retaining the aggregate vote history.
