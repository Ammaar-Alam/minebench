import assert from "node:assert/strict";
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

  console.log("SEO tests passed successfully");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
