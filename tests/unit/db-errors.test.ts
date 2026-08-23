import assert from "node:assert/strict";
import { isDatabaseUnavailableError } from "../../lib/db/errors";

assert.equal(
  isDatabaseUnavailableError(
    new Error(
      "Error querying the database: FATAL: Failed to connect to database: {:error, :timeout}",
    ),
  ),
  true,
);
assert.equal(
  isDatabaseUnavailableError(
    Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }),
  ),
  true,
);
assert.equal(
  isDatabaseUnavailableError(
    Object.assign(new Error("Server has closed the connection"), { code: "P1017" }),
  ),
  true,
);
assert.equal(isDatabaseUnavailableError(new Error("Unique constraint failed")), false);

console.log("database error classification checks passed");
