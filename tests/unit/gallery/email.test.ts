import assert from "node:assert/strict";
import { renderGalleryNotification } from "../../../lib/gallery/email";

const email = renderGalleryNotification({
  heading: "Gallery report",
  intro: "Review the reported contribution.",
  details: {
    Prompt: '<img src=x onerror="alert(1)">',
    Note: "A & B",
  },
});
assert.equal(email.html.includes("<img src=x"), false);
assert.match(email.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(email.html, /A &amp; B/);

console.log("Gallery email checks passed");
