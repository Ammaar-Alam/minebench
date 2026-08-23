import assert from "node:assert/strict";
import {
  renderContactNotification,
  renderContactReceipt,
} from "../../lib/contactEmail";
import type { ContactSubmission } from "../../lib/contact";

const submission: ContactSubmission = {
  category: "feature",
  title: 'Add <script> & "quotes"',
  email: "researcher@example.com",
  message: "First line\n<img src=x onerror=alert(1)> & more",
};

const notification = renderContactNotification(submission);
assert.equal(
  notification.subject,
  '[MineBench Contact] Feature request: Add <script> & "quotes"',
);
assert.match(notification.text, /Email: researcher@example\.com/);
assert.match(notification.text, /<img src=x onerror=alert\(1\)> & more/);
assert.match(notification.html, /Add &lt;script&gt; &amp; &quot;quotes&quot;/);
assert.match(notification.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; more/);
assert.doesNotMatch(notification.html, /<script>/);
assert.doesNotMatch(notification.html, /<img src=x/);
assert.match(notification.html, /mailto:researcher@example\.com/);
assert.match(notification.html, /https:\/\/minebench\.ai\/icon\.png/);

const receipt = renderContactReceipt(submission);
assert.equal(receipt.subject, "MineBench received your message");
assert.match(receipt.text, /Thanks for reaching out/);
assert.match(receipt.text, /Category: Feature request/);
assert.doesNotMatch(receipt.text, /Add <script> & "quotes"/);
assert.doesNotMatch(receipt.text, /First line/);
assert.match(receipt.html, /Thanks for reaching out/);
assert.match(receipt.html, /Feature request/);
assert.doesNotMatch(receipt.html, /Add &lt;script&gt;/);
assert.doesNotMatch(receipt.html, /First line/);
assert.doesNotMatch(receipt.html, /<script>/);
assert.doesNotMatch(receipt.html, /<img src=x/);
assert.match(receipt.html, /Return to MineBench/);
assert.match(receipt.html, /support@minebench\.ai/);

const anonymousNotification = renderContactNotification({
  category: "bug",
  title: "Viewer stalls",
  message: "The build never appears.",
});
assert.match(anonymousNotification.text, /Email: Not provided/);
assert.doesNotMatch(anonymousNotification.html, />Reply</);

console.log("contact email template checks passed");
