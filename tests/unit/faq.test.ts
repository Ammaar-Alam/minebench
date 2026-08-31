import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FAQ_ITEMS, FAQ_SECTIONS } from "../../lib/faq";
import { faqPageJsonLd } from "../../lib/seo";

const itemIds = FAQ_ITEMS.map((item) => item.id);
const sectionIds = FAQ_SECTIONS.map((section) => section.id);

assert.equal(new Set(itemIds).size, itemIds.length, "FAQ item IDs must be unique");
assert.equal(new Set(sectionIds).size, sectionIds.length, "FAQ section IDs must be unique");

for (const id of [...sectionIds, ...itemIds]) {
  assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `Invalid FAQ anchor: ${id}`);
}

for (const item of FAQ_ITEMS) {
  assert.ok(item.question.trim().endsWith("?"), `FAQ question needs punctuation: ${item.id}`);
  assert.ok(item.answer.length > 0, `FAQ answer is missing: ${item.id}`);
  assert.ok(item.answer.every((paragraph) => paragraph.trim().length > 0));
}

const galleryMethodology = FAQ_ITEMS.find(
  (item) => item.id === "how-does-the-gallery-shape-the-benchmark",
);
assert.ok(
  galleryMethodology?.answer.join(" ").includes("highest-voted prompts") &&
    galleryMethodology.answer.join(" ").includes("run-to-run variation"),
  "FAQ should explain manual prompt promotion and official retests",
);

const nondeterminism = FAQ_ITEMS.find(
  (item) => item.id === "how-does-minebench-account-for-nondeterminism",
);
const nondeterminismAnswer = nondeterminism?.answer.join(" ") ?? "";
assert.ok(
  nondeterminismAnswer.includes("three times") &&
    nondeterminismAnswer.includes("provider API costs") &&
    nondeterminismAnswer.includes("official Gallery prompt"),
  "FAQ should explain the ideal repeat protocol, cost constraint, and community reruns",
);

const readme = readFileSync("README.md", "utf8");
for (const item of FAQ_ITEMS) {
  // Private evaluations stay discoverable without README promotion
  if (item.id === "can-organizations-run-private-evaluations") continue;
  assert.ok(
    readme.includes(`https://minebench.ai/faq#${item.id}`),
    `README is missing the FAQ link for ${item.id}`,
  );
}

const structuredData = faqPageJsonLd(
  FAQ_ITEMS.map((item) => ({
    question: item.question,
    answer: item.answer.join("\n\n"),
  })),
);

assert.equal(structuredData["@type"], "FAQPage");
assert.equal(structuredData.mainEntity.length, FAQ_ITEMS.length);
assert.equal(structuredData.mainEntity[0]?.name, FAQ_ITEMS[0]?.question);

console.log("FAQ checks passed");
