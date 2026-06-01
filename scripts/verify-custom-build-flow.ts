import "dotenv/config";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { LOCAL_BUILD_STORAGE_BUCKET } from "@/lib/storage/buildPayload";
import { generateCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { sha256Hex } from "@/lib/custom-builds/artifacts";
import { createCustomBuildArtifactSignedUrl, downloadCustomBuildArtifactBytes } from "@/lib/custom-builds/storage";
import { runCustomBuildWorkerOnce } from "@/lib/custom-builds/worker";
import { prisma } from "@/lib/prisma";
import type { VoxelBuild } from "@/lib/voxel/types";

process.env.CUSTOM_BUILD_STUB_PROVIDER = "1";
process.env.CUSTOM_BUILD_STORAGE_BUCKET = LOCAL_BUILD_STORAGE_BUCKET;
process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR =
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR?.trim() || ".custom-build-storage/verify";
process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET =
  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET?.trim() || "custom-build-verify-secret";

function fixtureBuild(): VoxelBuild {
  const blocks: VoxelBuild["blocks"] = [];
  for (let x = 0; x < 16; x += 1) {
    for (let z = 0; z < 16; z += 1) {
      blocks.push({ x, y: 0, z, type: "stone" });
    }
  }
  for (let y = 1; y <= 12; y += 1) {
    blocks.push({ x: 3, y, z: 8, type: "stone_bricks" });
    blocks.push({ x: 12, y, z: 8, type: "stone_bricks" });
  }
  for (let x = 3; x <= 12; x += 1) {
    const height = 12 + Math.round(Math.sin(((x - 3) / 9) * Math.PI) * 4);
    blocks.push({ x, y: height, z: 8, type: "stone_bricks" });
  }
  return { version: "1.0", blocks };
}

function assertSafeVerificationDatabase() {
  if (process.env.CUSTOM_BUILD_VERIFY_ALLOW_REMOTE === "1") return;
  if (process.env.MINEBENCH_LOCAL_ENV === "1") return;
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const url = new URL(raw);
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return;
  } catch {
    // Prisma will report the missing/invalid URL more precisely if the caller opts in.
  }
  throw new Error(
    "custom:verify only runs against the local database by default. Use `pnpm env:localdb` and `pnpm local:prisma:migrate`, then run it through `node scripts/with-local-env.mjs pnpm custom:verify`.",
  );
}

async function main() {
  assertSafeVerificationDatabase();
  const publicId = generateCustomBuildPublicId();
  const prompt = "Build a small stone arch with two pillars and a flat base.";
  const build = fixtureBuild();

  const customBuild = await prisma.customBuild.create({
    data: {
      publicId,
      status: "queued",
      promptText: prompt,
      promptSha256: sha256Hex(prompt),
      gridSize: 64,
      palette: "simple",
      modelKind: "catalog",
      modelKey: "gemini_3_5_flash",
      modelProvider: "gemini",
      modelId: "gemini-3.5-flash",
      modelDisplayName: "Gemini 3.5 Flash",
      openRouterModelId: "google/gemini-3.5-flash",
      jobs: {
        create: {
          type: "generate",
          status: "queued",
          payload: {
            requestedExports: ["glb", "schem"],
            stubBuild: build,
          },
        },
      },
      events: {
        create: {
          seq: 1,
          type: "queued",
          data: { stage: "queued" },
        },
      },
    },
  });

  try {
    assert.deepEqual(await runCustomBuildWorkerOnce("verify-worker"), {
      processed: true,
      jobType: "generate",
      jobId: (await prisma.customBuildJob.findFirstOrThrow({
        where: { customBuildId: customBuild.id, type: "generate" },
        select: { id: true },
      })).id,
    });
    assert.equal((await runCustomBuildWorkerOnce("verify-worker")).processed, true);
    assert.equal((await runCustomBuildWorkerOnce("verify-worker")).processed, true);

    const completed = await prisma.customBuild.findUniqueOrThrow({
      where: { id: customBuild.id },
      include: {
        artifacts: { orderBy: { kind: "asc" } },
        events: { orderBy: { seq: "asc" } },
        jobs: true,
        secret: true,
      },
    });

    assert.equal(completed.status, "succeeded");
    assert.equal(completed.secret, null);
    assert.ok((completed.blockCount ?? 0) >= 200);
    assert.ok(completed.buildSha256);
    assert.ok(completed.artifacts.some((artifact) => artifact.kind === "build_json"));
    assert.ok(completed.artifacts.some((artifact) => artifact.kind === "preview_json"));
    assert.ok(completed.artifacts.some((artifact) => artifact.kind === "glb"));
    assert.ok(completed.artifacts.some((artifact) => artifact.kind === "schem"));
    assert.ok(completed.events.some((event) => event.type === "complete"));
    assert.ok(completed.events.some((event) => event.type === "export_complete"));

    const json = completed.artifacts.find((artifact) => artifact.kind === "build_json");
    assert.ok(json);
    const jsonBytes = await downloadCustomBuildArtifactBytes({ bucket: json.bucket, path: json.path });
    const storedBuild = JSON.parse(gunzipSync(jsonBytes).toString("utf8")) as VoxelBuild;
    assert.equal(storedBuild.blocks.length, completed.blockCount);
    const signedUrl = await createCustomBuildArtifactSignedUrl({ bucket: json.bucket, path: json.path });
    assert.match(signedUrl, /^file:\/\//);

    const glb = completed.artifacts.find((artifact) => artifact.kind === "glb");
    assert.ok(glb);
    const glbBytes = await downloadCustomBuildArtifactBytes({ bucket: glb.bucket, path: glb.path });
    assert.equal(Buffer.from(glbBytes.subarray(0, 4)).toString("utf8"), "glTF");

    const schem = completed.artifacts.find((artifact) => artifact.kind === "schem");
    assert.ok(schem);
    const schemBytes = await downloadCustomBuildArtifactBytes({ bucket: schem.bucket, path: schem.path });
    assert.doesNotThrow(() => gunzipSync(schemBytes));

    console.log(`custom build verification passed for ${publicId}`);
  } finally {
    await prisma.customBuild.deleteMany({ where: { id: customBuild.id } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
