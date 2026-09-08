import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GalleryLoading from "../../app/gallery/loading";
import GalleryDetailLoading from "../../app/gallery/[publicId]/loading";
import { GallerySkeletonGrid } from "../../components/gallery/GalleryExplore";

Object.assign(globalThis, { React });

const detail = renderToStaticMarkup(React.createElement(GalleryDetailLoading));
assert.match(detail, /aria-label="Loading gallery prompt"/,
  "detail navigation must retain the prompt and viewer layout while loading");
assert.doesNotMatch(detail, /Loading gallery prompts|Search prompts|Sign in/);

const gallery = renderToStaticMarkup(React.createElement(GalleryLoading));
assert.doesNotMatch(gallery, /Sign in|\/sign-in/,
  "the loading fallback must not guess the account state");

const grid = renderToStaticMarkup(React.createElement(GallerySkeletonGrid, { count: 24 }));
assert.equal(grid.match(/animate-pulse/g)?.length, 24,
  "loading cards should share one pulse per card");
assert.equal(grid.match(/motion-reduce:animate-none/g)?.length, 24);
console.log("Gallery loading checks passed");
