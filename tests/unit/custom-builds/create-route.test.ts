import assert from "node:assert/strict";

const previousCustomBuildsEnabled = process.env.CUSTOM_BUILDS_ENABLED;
const previousKeySecret = process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET;
process.env.CUSTOM_BUILDS_ENABLED = "1";
process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = "unit-test-secret-material";

let createdCustomBuild: Record<string, unknown> | null = null;

const fakePrisma = {
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
    callback({
      customBuild: {
        create: async (args: { data: Record<string, unknown> }) => {
          createdCustomBuild = args.data;
          return args.data;
        },
      },
      customBuildStatsDaily: {
        upsert: async () => ({}),
      },
    }),
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function main() {
  const { POST } = await import("../../../app/api/custom-builds/route");
  const response = await POST(
    new Request("http://localhost/api/custom-builds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Build a small stone arch",
        gridSize: 64,
        palette: "simple",
        model: { kind: "catalog", modelKey: "gemini_3_5_flash" },
        providerKeys: { gemini: "google-key" },
        preferOpenRouter: true,
      }),
    }),
  );

  assert.equal(response.status, 202);
  assert.ok(createdCustomBuild, "custom build should be persisted");
  assert.equal(createdCustomBuild.preferOpenRouter, false);
  assert.equal((createdCustomBuild.secret as { create: { provider: string } }).create.provider, "gemini");

  console.log("custom build create route checks passed");
}

main()
  .finally(() => {
    if (previousCustomBuildsEnabled === undefined) {
      delete process.env.CUSTOM_BUILDS_ENABLED;
    } else {
      process.env.CUSTOM_BUILDS_ENABLED = previousCustomBuildsEnabled;
    }
    if (previousKeySecret === undefined) {
      delete process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET;
    } else {
      process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = previousKeySecret;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
