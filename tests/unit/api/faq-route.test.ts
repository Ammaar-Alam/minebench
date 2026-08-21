import assert from "node:assert/strict";

import { GET } from "../../../app/api/faq/route";
import { FAQ_SECTIONS } from "../../../lib/faq";

async function main() {
  const response = GET();

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
  );
  assert.deepEqual(await response.json(), { sections: FAQ_SECTIONS });

  console.log("FAQ route contract checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
