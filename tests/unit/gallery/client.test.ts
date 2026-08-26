import assert from "node:assert/strict";
import { publishGenerationToGallery } from "../../../lib/gallery/client";

const originalFetch = globalThis.fetch;

async function main() {
  const requests: Array<{ url: string; body: unknown }> = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ created: true, candidate: { id: "new-candidate" } }, { status: 201 });
    }) as typeof fetch;

    assert.equal(await publishGenerationToGallery("build-new", false), "new-candidate");
    assert.deepEqual(requests, [{
      url: "/api/gallery/candidates",
      body: { generationId: "build-new", postAnonymously: false },
    }]);

    requests.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return url.endsWith("/examples")
        ? Response.json({ created: false }, { status: 200 })
        : Response.json({ created: false, candidate: { id: "existing-candidate" } }, { status: 200 });
    }) as typeof fetch;

    assert.equal(await publishGenerationToGallery("build-existing", true), "existing-candidate");
    assert.deepEqual(requests, [
      {
        url: "/api/gallery/candidates",
        body: { generationId: "build-existing", postAnonymously: true },
      },
      {
        url: "/api/gallery/candidates/existing-candidate/examples",
        body: { generationId: "build-existing", postAnonymously: true },
      },
    ]);

    globalThis.fetch = (async () => Response.json(
      { error: { message: "Gallery access suspended." } },
      { status: 403 },
    )) as typeof fetch;
    await assert.rejects(
      publishGenerationToGallery("build-rejected", false),
      /Gallery access suspended/,
    );

    console.log("Gallery client submission checks passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
