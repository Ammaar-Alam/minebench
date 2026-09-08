import assert from "node:assert/strict";
import { GET, PUT } from "../../../app/api/account/notifications/route";
import { PUT as register, DELETE as unregister } from "../../../app/api/account/notifications/devices/route";
import { notificationSettingsSchema, pushDeviceSchema } from "../../../lib/notifications/service";

async function main() {
  const settings = { generations: true, upvotes: false, contributions: true };
  assert.deepEqual(notificationSettingsSchema.parse(settings), settings);
  assert.deepEqual(notificationSettingsSchema.parse({ ...settings, email: false }), { ...settings, email: false });
  assert.equal(notificationSettingsSchema.safeParse({ ...settings, email: "false" }).success, false);
  for (const invalid of [{ settings }, { ...settings, generations: "true" }, { generations: true }, { ...settings, userId: "other" }]) {
    assert.equal(notificationSettingsSchema.safeParse(invalid).success, false);
  }
  assert.deepEqual(pushDeviceSchema.parse({ token: "A0ff", environment: "production" }), {
    token: "a0ff", environment: "production",
  });
  for (const token of ["", "abc", "xy", "ab".repeat(257)]) {
    assert.equal(pushDeviceSchema.safeParse({ token, environment: "development" }).success, false);
  }
  assert.equal(pushDeviceSchema.safeParse({ token: "ab", environment: "staging" }).success, false);
  assert.equal(pushDeviceSchema.safeParse({ token: "ab", environment: "production", userId: "other" }).success, false);

  for (const [handler, method] of [[GET, "GET"], [PUT, "PUT"], [register, "PUT"], [unregister, "DELETE"]] as const) {
    const response = await handler(new Request("http://localhost:3000/api/account/notifications", { method }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await response.json()).error.code, "authentication_required");
  }
  console.log("notification API boundary checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
