# MineBench Documentation

Use this index to find implementation-accurate docs for Arena ranking, generation tooling, and import workflows.

## Core

- [Arena Ranking System (Math + Matchmaking)](./arena-ranking-system.md)
- [Arena Ranking Validity Policy v2](./arena-ranking-validity-policy-v2.md)
- [Voxel Exec Runtime, Conversion, and Import Workflows](./voxel-exec-raw-output.md)

## Prompting

- [ChatGPT Web Voxel Prompt Template](./chatgpt-web-voxel-prompt.md)

## Related Repo Files

- Raw tool-call example: [`examples/voxel-exec-tool-call-example.json`](./examples/voxel-exec-tool-call-example.json)
- Tool-call conversion script: [`scripts/convert-voxel-tool-call.ts`](../scripts/convert-voxel-tool-call.ts)
- Local execution API: [`app/api/local/voxel-exec/route.ts`](../app/api/local/voxel-exec/route.ts)
- Arena matchmaking route: [`app/api/arena/matchup/route.ts`](../app/api/arena/matchup/route.ts)
- Arena vote/rating updates: [`app/api/arena/vote/route.ts`](../app/api/arena/vote/route.ts)
- Rating math implementation: [`lib/arena/rating.ts`](../lib/arena/rating.ts)
- Leaderboard API: [`app/api/leaderboard/route.ts`](../app/api/leaderboard/route.ts)
- Voxel execution runtime: [`lib/ai/tools/voxelExec.ts`](../lib/ai/tools/voxelExec.ts)
