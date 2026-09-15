import assert from "node:assert/strict";
import type { ClientMetricSample } from "../../../lib/observability/customMetrics";

async function main() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = globalThis.fetch;
  const browser = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const requests: RequestInit[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/observability/client-metrics");
    requests.push(options!);
    return new Response(null, { status: 204 });
  };

  try {
    const { enqueueClientMetric } = await import("../../../lib/observability/clientMetrics");
    const sample: ClientMetricSample = {
      kind: "matchup", mode: "random", laneABlocks: "under-8k", laneBBlocks: "under-8k",
      headersMs: 10, bodyMs: 5, totalMs: 15,
    };
    enqueueClientMetric(sample);
    page.dispatchEvent(new Event("visibilitychange"));
    assert.equal(requests.length, 0, "Visible pages should retain the normal batching delay");
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    assert.equal(requests.length, 1, "Hiding the page must send pending metrics before the timer fires");
    browser.dispatchEvent(new Event("pagehide"));
    assert.equal(requests.length, 1, "Pagehide after visibilitychange must not duplicate samples");

    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    enqueueClientMetric(sample);
    browser.dispatchEvent(new Event("pagehide"));
    assert.equal(requests.length, 2, "Pagehide must also flush after the page is restored");
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(requests.length, 2, "Canceled flush timers must not resend samples");
    for (const request of requests) {
      assert.equal(request.keepalive, true);
      assert.equal(request.method, "POST");
      assert.deepEqual(JSON.parse(String(request.body)), { samples: [sample] });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
  console.log("Client metrics lifecycle checks passed");
}

main().catch(error => { console.error(error); process.exit(1); });
