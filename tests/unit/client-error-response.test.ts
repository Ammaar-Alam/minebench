import assert from "node:assert/strict";
import { readClientErrorResponse } from "../../lib/clientErrorResponse";

async function main() {
  const prismaError = new Response(
    JSON.stringify({
      error:
        "Invalid `prisma.build.findMany()` invocation: FATAL: Failed to connect to database: {:error, :timeout}",
    }),
    {
      status: 500,
      headers: { "Content-Type": "application/json" },
    },
  );
  assert.equal(
    await readClientErrorResponse(prismaError, "Request failed"),
    "The server had a problem. Please try again.",
  );

  const unavailable = new Response(
    JSON.stringify({ error: "Database is temporarily unavailable." }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
  assert.equal(
    await readClientErrorResponse(unavailable, "Request failed"),
    "The server is overloaded right now. Please try again shortly.",
  );

  const validationError = new Response(
    JSON.stringify({ error: "Prompt is required." }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );
  assert.equal(
    await readClientErrorResponse(validationError, "Request failed"),
    "Prompt is required.",
  );

  const missingKeyError = new Response(
    JSON.stringify({
      error: "Add an OpenRouter or provider API key in Generate settings.",
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );
  assert.equal(
    await readClientErrorResponse(missingKeyError, "Request failed"),
    "Add an OpenRouter or provider API key in Generate settings.",
  );

  const htmlError = new Response("<html>Internal Server Error</html>", {
    status: 400,
    headers: { "Content-Type": "text/html" },
  });
  assert.equal(await readClientErrorResponse(htmlError, "Request failed"), "Request failed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
