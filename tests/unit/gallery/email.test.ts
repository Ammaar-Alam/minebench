import assert from "node:assert/strict";
import { renderGalleryNotification } from "../../../lib/gallery/email";

const email = renderGalleryNotification({
  heading: "Gallery report",
  intro: "Review the reported contribution.",
  details: {
    Account: "builder@example.com",
    Prompt: '<img src=x onerror="alert(1)">',
    Note: "A & B",
  },
  action: {
    label: "Review submission",
    href: "https://minebench.test/admin/gallery?filter=<rejected>",
  },
});
assert.match(email.text, /Account: builder@example\.com/);
assert.match(email.text, /Review submission: https:\/\/minebench\.test\/admin\/gallery/);
assert.equal(email.html.includes("<img src=x"), false);
assert.match(email.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(email.html, /A &amp; B/);
assert.match(email.html, /builder@example\.com/);
assert.match(email.html, /Review submission/);
assert.match(email.html, /filter=&lt;rejected&gt;/);

console.log("Gallery email checks passed");
