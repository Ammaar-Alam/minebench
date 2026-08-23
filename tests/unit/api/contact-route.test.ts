import assert from "node:assert/strict";
import { handleContactPost } from "../../../lib/contactRoute";
import type { ContactSubmission } from "../../../lib/contact";

function request(body: unknown, headers?: HeadersInit) {
  return new Request("http://localhost/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  const deliveries: ContactSubmission[] = [];
  const deliver = async (submission: ContactSubmission) => {
    deliveries.push(submission);
    return "sent" as const;
  };

  const response = await handleContactPost(
    request({
      category: "feature",
      title: "  Better comparison links  ",
      email: "  researcher@example.com  ",
      message: "  Let people share a comparison.  ",
      website: "",
    }),
    deliver,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, receipt: "sent" });
  assert.deepEqual(deliveries, [
    {
      category: "feature",
      title: "Better comparison links",
      email: "researcher@example.com",
      message: "Let people share a comparison.",
    },
  ]);

  const noEmailResponse = await handleContactPost(
    request({
      category: "feedback",
      title: "Arena motion",
      email: "",
      message: "The reveal feels good.",
    }),
    async (submission) => {
      assert.equal(submission.email, undefined);
      return "not_requested";
    },
  );
  assert.deepEqual(await noEmailResponse.json(), { ok: true, receipt: "not_requested" });

  let honeypotDelivered = false;
  const honeypotResponse = await handleContactPost(
    request({
      category: "bug",
      title: "Bot message",
      email: "victim@example.com",
      message: "Relayed content",
      website: "https://spam.example",
    }),
    async () => {
      honeypotDelivered = true;
      return "sent";
    },
  );
  assert.equal(honeypotDelivered, false);
  assert.deepEqual(await honeypotResponse.json(), { ok: true, receipt: "sent" });

  const invalidBodies = [
    { category: "question", title: "Hello", message: "World" },
    { category: "other", title: "Hello\nBcc: victim@example.com", message: "World" },
    { category: "other", title: "Hello", email: "not-an-email", message: "World" },
    { category: "other", title: "", message: "World" },
    { category: "other", title: "Hello", message: "" },
    { category: "other", title: "Hello", message: "World", extra: true },
  ];
  for (const body of invalidBodies) {
    const invalidResponse = await handleContactPost(request(body), deliver);
    assert.equal(invalidResponse.status, 400);
    assert.deepEqual(await invalidResponse.json(), { error: "invalid_submission" });
  }

  const oversizedResponse = await handleContactPost(
    request(
      { category: "other", title: "Hello", message: "World" },
      { "content-length": "20000" },
    ),
    deliver,
  );
  assert.equal(oversizedResponse.status, 413);

  const receiptFailure = await handleContactPost(
    request({ category: "bug", title: "Viewer stalls", message: "No build", email: "a@b.co" }),
    async () => "failed",
  );
  assert.deepEqual(await receiptFailure.json(), { ok: true, receipt: "failed" });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const deliveryFailure = await handleContactPost(
      request({ category: "bug", title: "Viewer stalls", message: "No build" }),
      async () => {
        throw Object.assign(new Error("SMTP unavailable"), { code: "ECONNECTION" });
      },
    );
    assert.equal(deliveryFailure.status, 503);
    assert.deepEqual(await deliveryFailure.json(), { error: "delivery_unavailable" });
  } finally {
    console.error = originalConsoleError;
  }

  console.log("contact route checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
