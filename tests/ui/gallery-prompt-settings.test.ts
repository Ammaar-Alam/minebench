import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { GalleryDetail } from "../../components/gallery/GalleryDetail";
import { GalleryExplore } from "../../components/gallery/GalleryExplore";
import type { GalleryCandidatePayload, GalleryExamplePayload } from "../../lib/gallery/service";

Object.assign(globalThis, { React });

const router = { back() {}, forward() {}, push() {}, replace() {}, refresh() {}, async prefetch() {} };
const cover: GalleryExamplePayload = {
  id: "example-einstein", canRemove: false, buildId: "cb_einstein", attribution: "Builder",
  createdAt: "2026-09-30T00:00:00.000Z", runAt: "2026-09-30T00:00:00.000Z",
  model: { kind: "catalog", label: "GPT 6 Astra Pro" }, gridSize: 512, palette: "advanced",
  blockCount: 1, jsonBytes: 100, generationTimeMs: 1000, checksum: "a".repeat(64),
  previewUrl: null, thumbnailUrl: null, worldViewerUrl: null, viewerUrl: null,
};
const community: GalleryCandidatePayload = {
  id: "gal_einstein", prompt: "Photorealistic face of Albert Einstein", attribution: "Builder",
  upvoteCount: 0, upvoted: false, selected: false, arenaSetup: null, arenaPromptId: null,
  canRemove: false, publishedAt: cover.createdAt, exampleCount: 1, cover, alternate: null,
  modelLabels: [cover.model.label], matchedModelLabels: [],
};

for (const [candidate, setup] of [
  [community, { gridSize: "512", palette: "advanced" }],
  [{ ...community, selected: true, arenaSetup: { gridSize: 256, palette: "simple" } }, { gridSize: "256", palette: "simple" }],
  [{ ...community, cover: null, exampleCount: 0 }, { gridSize: null, palette: null }],
] as const) {
  const surfaces = [
    React.createElement(GalleryExplore, {
      initialItems: [candidate], initialCursor: null, sort: "new",
      signedIn: false, hasNickname: false, suspended: false,
    }),
    React.createElement(GalleryDetail, {
      candidate: {
        ...candidate, examples: candidate.cover ? [candidate.cover] : [],
        nextExamplesCursor: null, navigation: null,
      },
    }),
  ];
  for (const surface of surfaces) {
    const markup = renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router }, surface));
    const href = markup.match(/<a [^>]*href="([^"]+)"[^>]*>Use prompt<\/a>/)?.[1];
    assert.ok(href, "each Gallery surface should render Use prompt");
    const params = new URL(href.replaceAll("&amp;", "&"), "https://minebench.ai").searchParams;
    assert.equal(params.get("prompt"), candidate.prompt);
    assert.equal(params.get("mode"), "live");
    assert.equal(params.get("gridSize"), setup.gridSize, "Use prompt should preserve the build size");
    assert.equal(params.get("palette"), setup.palette, "Use prompt should preserve the palette");
  }
}

console.log("Gallery prompt settings checks passed");
