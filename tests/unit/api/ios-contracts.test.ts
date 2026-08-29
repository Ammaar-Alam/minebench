import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://arjbynhjeofgwfmpjfvf.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_native_contract_test";
  process.env.MINEBENCH_FREE_OPENROUTER_API_KEY = "hosted-contract-test-key";

  const [
    { GET: getAuthConfig },
    { GET: getGenerationOptions },
    { GET: getAssociation },
    { serializeAccount },
  ] =
    await Promise.all([
      import("../../../app/api/auth/config/route"),
      import("../../../app/api/generation-options/route"),
      import("../../../app/.well-known/apple-app-site-association/route"),
      import("../../../lib/account/service"),
    ]);

  const configResponse = await getAuthConfig();
  assert.equal(configResponse.status, 200);
  assert.match(configResponse.headers.get("cache-control") ?? "", /public/);
  assert.deepEqual(await configResponse.json(), {
    supabaseUrl: "https://arjbynhjeofgwfmpjfvf.supabase.co",
    publishableKey: "sb_publishable_native_contract_test",
  });

  const optionsResponse = await getGenerationOptions();
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json() as {
    models: Array<{
      key: string;
      provider: string;
      displayName: string;
      directKey: string | null;
      openRouter: boolean;
      hostedEligible: boolean;
    }>;
  };
  assert.ok(options.models.length > 20);
  assert.equal(new Set(options.models.map((model) => model.key)).size, options.models.length);
  assert.equal(options.models.some((model) => model.key === "openai_gpt_4_5_web_harness"), false);
  assert.deepEqual(
    options.models.find((model) => model.key === "gemini_3_7_flash"),
    {
      key: "gemini_3_7_flash",
      provider: "gemini",
      displayName: "Gemini 3.7 Flash",
      directKey: "gemini",
      openRouter: true,
      hostedEligible: true,
    },
  );
  assert.equal(
    options.models.find((model) => model.key === "qwen_qwen3_8_max")?.directKey,
    null,
  );

  const associationResponse = await getAssociation();
  assert.equal(associationResponse.status, 200);
  assert.equal(associationResponse.headers.get("content-type"), "application/json");
  assert.deepEqual(await associationResponse.json(), {
    applinks: {
      apps: [],
      details: [{
        appID: "VM6477A6M8.com.ammaaralam.minebench",
        components: [
          { "/": "/gallery/*", comment: "MineBench Gallery" },
          { "/": "/sandbox", comment: "MineBench Sandbox" },
          { "/": "/leaderboard/*", comment: "MineBench Leaderboard" },
        ],
      }],
    },
  });

  assert.deepEqual(serializeAccount({
    id: "34f9ac48-9913-4e6c-850c-b2d99605d390",
    email: "native-account@example.test",
    displayName: "Native Account",
    publicNickname: "Builder",
    isMineBenchAdmin: false,
    gallerySuspendedAt: new Date("2026-08-29T13:00:00.000Z"),
    gallerySuspensionReason: "Review pending",
    hostedGenerationCount: 4,
    hostedGenerationLimit: 10,
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
  }), {
    id: "34f9ac48-9913-4e6c-850c-b2d99605d390",
    email: "native-account@example.test",
    displayName: "Native Account",
    publicNickname: "Builder",
    createdAt: "2026-08-01T12:00:00.000Z",
    gallerySuspension: {
      suspendedAt: "2026-08-29T13:00:00.000Z",
      reason: "Review pending",
    },
    hostedGeneration: {
      used: 4,
      limit: 10,
      remaining: 6,
      available: true,
    },
  });

  const authenticatedRoutes = [
    "app/api/arena/vote/route.ts",
    "app/api/gallery/candidates/route.ts",
    "app/api/gallery/candidates/[publicId]/route.ts",
    "app/api/gallery/candidates/[publicId]/examples/route.ts",
    "app/api/gallery/candidates/[publicId]/vote/route.ts",
    "app/api/gallery/reports/route.ts",
    "app/api/generations/route.ts",
    "app/api/generations/[id]/route.ts",
    "app/api/generations/[id]/cancel/route.ts",
    "app/api/generations/[id]/retry/route.ts",
    "app/api/generations/[id]/download/route.ts",
    "app/api/generations/[id]/artifacts/[kind]/route.ts",
  ];
  for (const path of authenticatedRoutes) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /@\/lib\/auth\/request/);
    assert.match(source, /getAuthenticatedUserId\((request|req)\)/);
  }
  const galleryDetail = readFileSync("app/api/gallery/candidates/[publicId]/route.ts", "utf8");
  assert.match(galleryDetail, /navigationSort:/);
  const galleryArtifact = readFileSync("app/api/gallery/examples/[id]/[kind]/route.ts", "utf8");
  assert.match(galleryArtifact, /kind === "thumbnail"/);
  assert.match(galleryArtifact, /preview_mbv4/);
  const cancelGeneration = readFileSync("app/api/generations/[id]/cancel/route.ts", "utf8");
  assert.match(cancelGeneration, /apiJson\(\{ generation: await cancelSavedGeneration/);
  for (const path of [
    "app/api/account/route.ts",
    "app/api/account/session/route.ts",
    "app/api/account/ranking/route.ts",
    "app/api/account/gallery-appeal/route.ts",
  ]) {
    assert.match(readFileSync(path, "utf8"), /@\/lib\/auth\/request/);
  }

  console.log("iOS backend contract checks passed");
}

void main();
