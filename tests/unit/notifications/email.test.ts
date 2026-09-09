import assert from "node:assert/strict";
import { notificationEmailRecipientAllowed, renderNotificationEmail } from "../../../lib/notifications/email";
import type { PushPayload } from "../../../lib/notifications/apns";

const payload: PushPayload = {
  aps: { alert: { title: "Build ready", body: "Your <build> is ready & waiting." }, sound: "default", "thread-id": "generation:cb_test" },
  kind: "generation_succeeded", id: "cb_test", userId: "user",
};
process.env.MINEBENCH_SITE_URL = "https://minebench.ai/";
const email = renderNotificationEmail(payload);
assert.equal(email.subject, "MineBench: Build ready");
assert.ok(email.text.includes("https://minebench.ai/account?generation=cb_test"));
assert.ok(email.html.includes("https://minebench.ai/account#notifications"));
assert.ok(email.html.includes("Your &lt;build&gt; is ready &amp; waiting."));
assert.ok(email.html.includes("max-width:560px"));
assert.ok(!email.html.includes("Your <build>"));
assert.ok(renderNotificationEmail({ ...payload, kind: "gallery_contribution", id: "gal_a&b" }).html.includes("/gallery/gal_a%26b"));

delete process.env.NOTIFICATION_EMAIL_TEST_RECIPIENT;
delete process.env.MINEBENCH_ENVIRONMENT;
assert.equal(notificationEmailRecipientAllowed("owner@example.test"), false);
process.env.MINEBENCH_ENVIRONMENT = "alpha";
assert.equal(notificationEmailRecipientAllowed("owner@example.test"), false);
process.env.NOTIFICATION_EMAIL_TEST_RECIPIENT = "OWNER@example.test";
assert.equal(notificationEmailRecipientAllowed("owner@example.test"), true);
assert.equal(notificationEmailRecipientAllowed("other@example.test"), false);
process.env.MINEBENCH_ENVIRONMENT = "production";
assert.equal(notificationEmailRecipientAllowed("other@example.test"), false);
delete process.env.NOTIFICATION_EMAIL_TEST_RECIPIENT;
assert.equal(notificationEmailRecipientAllowed("other@example.test"), true);
assert.equal(notificationEmailRecipientAllowed("owner@example.test,other@example.test"), false);
console.log("notification email template and recipient checks passed");
