import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const eventsRouteSource = readFileSync("app/api/custom-builds/[id]/events/route.ts", "utf8");

const publicId = "cb_123456789012345678901234";
const customBuildId = "custom-build-row";
const events = [
  { seq: 1, type: "started", data: { stage: "generating" } },
  { seq: 2, type: "complete", data: { stage: "complete" } },
  { seq: 3, type: "export_queued", data: { format: "glb" } },
  { seq: 4, type: "export_started", data: { format: "glb" } },
  { seq: 5, type: "export_complete", data: { format: "glb" } },
];

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
      events.filter((event) => event.seq > args.where.seq.gt),
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
    eventsRouteSource.includes("if (closed) return;\n        if (terminalWithNoPendingExports)") &&
      eventsRouteSource.includes("if (closed) return;\n          for (const event of terminalEvents)") &&
      eventsRouteSource.includes("if (closed) return;\n        controller.enqueue(encoder.encode(`: ping"),
    "SSE route should recheck stream closure before terminal replay and ping enqueues",
  );

  console.log("custom build SSE replay checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
