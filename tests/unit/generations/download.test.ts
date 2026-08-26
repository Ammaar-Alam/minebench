import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { expandSavedGenerationResponse } from "../../../lib/generations/download";

const json = JSON.stringify({ version: "1.0", blocks: [{ x: 1, y: 2, z: 3, type: "stone" }] });

async function main() {
  const nestedGzip = await expandSavedGenerationResponse(
    new Response(gzipSync(json), {
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "br",
      },
    }),
  );
  assert.equal(await new Response(nestedGzip).text(), json);

  const plain = await expandSavedGenerationResponse(
    new Response(json, { headers: { "Content-Type": "application/json" } }),
  );
  assert.equal(await new Response(plain).text(), json);

  console.log("saved generation download checks passed");
}

void main();
