import assert from "node:assert/strict";

import { POST } from "../../../app/api/local/voxel-exec/route";

async function main() {
  const request = new Request("http://localhost:3000/api/local/voxel-exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "const R = rng(); R();",
      gridSize: 64,
      palette: "simple",
      seed: 123,
    }),
  });

  const response = await POST(request);
  const body = (await response.json()) as { error?: unknown };

  assert.equal(response.status, 400);
  assert.equal(body.error, "R is not a function");

  console.log("local voxel exec error propagation checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
