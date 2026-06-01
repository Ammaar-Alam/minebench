import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const eventsRouteSource = readFileSync("app/api/custom-builds/[id]/events/route.ts", "utf8");

const publicId = "cb_123456789012345678901234";
const customBuildId = "custom-build-row";
let eventMode: "replay" | "terminal-status-before-event" | "terminal-status-missing-event" = "replay";
const events = [
  { seq: 1, type: "started", data: { stage: "generating" } },
  { seq: 2, type: "complete", data: { stage: "complete" } },
  { seq: 3, type: "export_queued", data: { format: "glb" } },
  { seq: 4, type: "export_started", data: { format: "glb" } },
  { seq: 5, type: "export_complete", data: { format: "glb" } },
];
const persistedFallbackEvents: Array<{ seq: number; type: string; data: unknown }> = [];

function fallbackEventAtOrBefore(args: { where: { seq: { lte: number }; type: { in: string[] } } }) {
  if (eventMode === "replay") {
    return events.find((event) => event.seq <= args.where.seq.lte && args.where.type.in.includes(event.type)) ?? null;
  }
  if (eventMode === "terminal-status-missing-event") {
    return (
      persistedFallbackEvents.find(
        (event) => event.seq <= args.where.seq.lte && args.where.type.in.includes(event.type),
      ) ?? null
    );
  }
  return null;
}

const fakePrisma = {
  customBuild: {
    findUnique: async (args: { where: { publicId?: string; id?: string } }) => {
      if (args.where.publicId === publicId) return { id: customBuildId, status: "succeeded" };
      if (args.where.id === customBuildId) return { status: "succeeded", jobs: [] };
      return null;
    },
  },
  customBuildEvent: {
    findMany: async (args: { where: { customBuildId: string; seq: { gt: number } } }) =>
      eventMode === "replay" ? events.filter((event) => event.seq > args.where.seq.gt) : [],
    findFirst: async (args: { where: { seq: { lte: number }; type: { in: string[] } } }) =>
      fallbackEventAtOrBefore(args),
  },
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
    return callback({
      $queryRaw: async () => [{ id: customBuildId }],
      customBuildEvent: {
        findFirst: async (args: { where: { type: string } }) =>
          persistedFallbackEvents.find((event) => event.type === args.where.type) ?? null,
        aggregate: async () => ({
          _max: { seq: persistedFallbackEvents[persistedFallbackEvents.length - 1]?.seq ?? 0 },
        }),
        create: async (args: { data: { seq: number; type: string; data: unknown } }) => {
          persistedFallbackEvents.push(args.data);
          return args.data;
        },
      },
    });
  },
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function main() {
  const { GET } = await import("../../../app/api/custom-builds/[id]/events/route");
  const response = await GET(new Request(`http://localhost/api/custom-builds/${publicId}/events?after=0`), {
    params: Promise.resolve({ id: publicId }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /event: complete/);
  assert.match(text, /event: export_started/);
  assert.match(text, /event: export_complete/);
  assert.ok(
    text.indexOf("event: complete") < text.indexOf("event: export_complete"),
    "SSE replay should keep events appended after generation completion",
  );
  assert.ok(
    eventsRouteSource.includes("if (terminalWithNoPendingExports)") &&
      eventsRouteSource.includes("for (const event of terminalEvents)") &&
      eventsRouteSource.includes("hasCustomBuildEventAtOrBefore(customBuild.id, after, terminalTypes)") &&
      eventsRouteSource.includes("ensureCustomBuildEvent") &&
      eventsRouteSource.includes("if (closed) return;\n        controller.enqueue(encoder.encode(`: ping"),
    "SSE route should recheck stream closure and only close after a terminal event is replayed or already seen",
  );

  eventMode = "terminal-status-before-event";
  const controller = new AbortController();
  const raceResponse = await GET(
    new Request(`http://localhost/api/custom-builds/${publicId}/events?after=0`, { signal: controller.signal }),
    {
      params: Promise.resolve({ id: publicId }),
    },
  );
  assert.ok(raceResponse.body);
  const reader = raceResponse.body.getReader();
  await reader.read();
  const secondRead = await reader.read();
  controller.abort();
  assert.equal(
    secondRead.done,
    false,
    "SSE should keep polling when terminal status is visible before the terminal event is persisted",
  );
  await reader.cancel().catch(() => {});

  eventMode = "terminal-status-missing-event";
  persistedFallbackEvents.length = 0;
  const fallbackResponse = await GET(new Request(`http://localhost/api/custom-builds/${publicId}/events?after=0`), {
    params: Promise.resolve({ id: publicId }),
  });
  assert.ok(fallbackResponse.body);
  const fallbackReader = fallbackResponse.body.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < 4; i += 1) {
    const read = await Promise.race([
      fallbackReader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 3500),
      ),
    ]);
    if (read.value) chunks.push(decoder.decode(read.value));
    if (read.done) break;
  }
  await fallbackReader.cancel().catch(() => {});
  assert.equal(persistedFallbackEvents.length, 1);
  assert.match(chunks.join(""), /event: complete/);

  console.log("custom build SSE replay checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
