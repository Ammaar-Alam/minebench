import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  findCatalogEntryBySlugOrKey,
  MODEL_CATALOG,
  resolveModelSlug,
} from "../../lib/ai/modelCatalog";
import {
  datasetJsonLd,
  leaderboardItemListJsonLd,
  modelDetailJsonLd,
  SEO_KEYWORDS,
  softwareApplicationJsonLd,
  websiteJsonLd,
} from "../../lib/seo";
import sitemap from "../../app/sitemap";
import robots from "../../app/robots";
import { middleware } from "../../middleware";
import { getLeaderboardItemListRankings } from "../../lib/arena/stats";

async function main() {
  // 1. Model Slug Resolution
  for (const model of MODEL_CATALOG) {
    assert.equal(resolveModelSlug(model.key), model.slug);
    assert.equal(resolveModelSlug(model.slug), model.slug);

    const byKey = findCatalogEntryBySlugOrKey(model.key);
    assert.ok(byKey, `Failed to find model by key: ${model.key}`);
    assert.equal(byKey.slug, model.slug);

    const bySlug = findCatalogEntryBySlugOrKey(model.slug);
    assert.ok(bySlug, `Failed to find model by slug: ${model.slug}`);
    assert.equal(bySlug.key, model.key);
  }

  // 2. SEO Keywords
  const keywordSet = new Set<string>(SEO_KEYWORDS);
  assert.ok(keywordSet.has("voxelbench"), "SEO_KEYWORDS must include 'voxelbench'");
  assert.ok(keywordSet.has("voxel bench"), "SEO_KEYWORDS must include 'voxel bench'");
  assert.ok(
    keywordSet.has("voxelbench alternative"),
    "SEO_KEYWORDS must include 'voxelbench alternative'",
  );
  assert.ok(keywordSet.has("llm arena"), "SEO_KEYWORDS must include 'llm arena'");
  assert.ok(keywordSet.has("lm arena"), "SEO_KEYWORDS must include 'lm arena'");
  assert.ok(keywordSet.has("private evals"), "SEO_KEYWORDS must include 'private evals'");
  assert.ok(
    keywordSet.has("spatial reasoning benchmark"),
    "SEO_KEYWORDS must include 'spatial reasoning benchmark'",
  );
  assert.ok(
    keywordSet.has("open-source voxel AI benchmark"),
    "SEO_KEYWORDS must include 'open-source voxel AI benchmark'",
  );

  // 3. Structured Data Schemas
  assert.equal(websiteJsonLd["@type"], "WebSite");
  assert.equal(softwareApplicationJsonLd["@type"], "SoftwareApplication");
  assert.equal(datasetJsonLd["@type"], "Dataset");
  assert.ok(datasetJsonLd.keywords.includes("voxelbench"));
  assert.ok(datasetJsonLd.keywords.includes("voxel bench"));
  assert.ok(datasetJsonLd.keywords.includes("llm arena"));
  assert.ok(datasetJsonLd.keywords.includes("private evals"));

  const sampleItemList = leaderboardItemListJsonLd([
    { name: "Model A", rank: 1, path: "/leaderboard/model-a" },
    { name: "Model B", rank: 2, path: "/leaderboard/model-b" },
  ]);
  assert.equal(sampleItemList["@type"], "ItemList");
  assert.equal(sampleItemList.itemListElement.length, 2);
  assert.equal(sampleItemList.itemListElement[0].position, 1);
  assert.equal(sampleItemList.itemListElement[0].url, "https://minebench.ai/leaderboard/model-a");

  const sampleModelDetail = modelDetailJsonLd({
    key: "openai_gpt_5_6_luna",
    slug: "gpt-5-6-luna",
    displayName: "GPT 5.6 Luna Pro",
    provider: "OpenAI",
    eloRating: 1650,
    winCount: 20,
    lossCount: 5,
    drawCount: 2,
    bothBadCount: 1,
  });
  assert.equal(sampleModelDetail["@type"], "WebPage");
  assert.equal(sampleModelDetail.url, "https://minebench.ai/leaderboard/gpt-5-6-luna");

  // 4. Sitemap Generation
  const sitemapEntries = await sitemap();
  assert.ok(sitemapEntries.length >= 5 + MODEL_CATALOG.filter((m) => m.enabled).length);
  const staticUrls = sitemapEntries.map((e) => e.url);
  assert.ok(staticUrls.includes("https://minebench.ai/private-evaluations"));

  const modelUrls = sitemapEntries
    .map((e) => e.url)
    .filter((url) => url.includes("/leaderboard/"));

  for (const model of MODEL_CATALOG.filter((m) => m.enabled)) {
    const expectedUrl = `https://minebench.ai/leaderboard/${encodeURIComponent(model.slug)}`;
    assert.ok(modelUrls.includes(expectedUrl), `Sitemap missing canonical url: ${expectedUrl}`);
  }

  // 5. Robots.txt
  const robotsRules = robots();
  assert.ok(Array.isArray(robotsRules.rules));
  const primaryRule = robotsRules.rules[0];
  assert.ok(Array.isArray(primaryRule.allow));
  assert.ok(primaryRule.allow.includes("/private-evaluations"));
  assert.ok(Array.isArray(primaryRule.disallow));
  assert.ok(primaryRule.disallow.includes("/api/"));
  assert.ok(primaryRule.disallow.includes("/admin/"));
  assert.ok(primaryRule.disallow.includes("/local"));

  // 6. Middleware 308 Permanent Redirect for Legacy Model Keys with Query Preservation
  const legacyReqWithQuery = new NextRequest(
    "https://minebench.ai/leaderboard/openai_gpt_5_6_luna?tab=prompts&build=build-1&utm_source=share",
  );
  const legacyRedirectRes = await middleware(legacyReqWithQuery);
  assert.equal(legacyRedirectRes.status, 308, "Legacy model keys must redirect with HTTP 308");
  assert.equal(
    legacyRedirectRes.headers.get("location"),
    "https://minebench.ai/leaderboard/gpt-5-6-luna?tab=prompts&build=build-1&utm_source=share",
    "308 redirect must preserve query parameters and target canonical slug",
  );

  const canonicalReq = new NextRequest(
    "https://minebench.ai/leaderboard/gpt-5-6-luna?tab=prompts&build=build-1",
  );
  const canonicalRes = await middleware(canonicalReq);
  assert.equal(
    canonicalRes.status,
    200,
    "Canonical slugs must pass through middleware without redirect",
  );

  // 7. Malformed percent-encoded paths guard
  const malformedReq1 = new NextRequest("https://minebench.ai/leaderboard/foo%bar");
  const malformedRes1 = await middleware(malformedReq1);
  assert.equal(
    malformedRes1.status,
    200,
    "Malformed percent-encoded paths (e.g. %bar) must pass through safely without 500 error",
  );

  const malformedReq2 = new NextRequest("https://minebench.ai/leaderboard/%ED%A0%80");
  const malformedRes2 = await middleware(malformedReq2);
  assert.equal(
    malformedRes2.status,
    200,
    "Invalid UTF-8 surrogate percent-encoded paths must pass through safely without 500 error",
  );

  // 8. Live Leaderboard ItemList Rankings Helper
  const rankings = await getLeaderboardItemListRankings();
  assert.ok(Array.isArray(rankings), "getLeaderboardItemListRankings must return an array");
  for (const item of rankings) {
    assert.ok(typeof item.name === "string" && item.name.length > 0);
    assert.ok(typeof item.rank === "number" && item.rank > 0);
    assert.ok(item.path.startsWith("/leaderboard/"));
  }

  // 9. Leaderboard page ISR revalidation
  const leaderboardPageModule = await import("../../app/leaderboard/page");
  assert.equal(
    leaderboardPageModule.revalidate,
    60,
    "app/leaderboard/page.tsx must export revalidate = 60 for ISR freshness",
  );

  console.log("SEO tests passed successfully");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
