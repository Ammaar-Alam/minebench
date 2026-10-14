import assert from "node:assert/strict";
import { wantsAppPrompt } from "../../../components/arena/AppPrompt";

const iphone = (tail: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${tail}`;

assert.equal(wantsAppPrompt(iphone("Version/26.0 Mobile/15E148 Safari/604.1")), false, "Safari gets Apple's own banner");
assert.equal(wantsAppPrompt(iphone("CriOS/140.0.0.0 Mobile/15E148 Safari/604.1")), true);
assert.equal(wantsAppPrompt(iphone("FxiOS/140.0 Mobile/15E148 Safari/605.1.15")), true);
assert.equal(wantsAppPrompt(iphone("Version/26.0 EdgiOS/140.0 Mobile/15E148 Safari/605.1.15")), true);
assert.equal(wantsAppPrompt(iphone("Mobile/15E148")), true, "unbranded in-app web views never show Apple's banner");
assert.equal(wantsAppPrompt(iphone("Mobile/15E148 Instagram 350.0.0")), true, "in-app browsers never show Apple's banner");
assert.equal(wantsAppPrompt(iphone("Mobile/15E148 Twitter for iPhone/11.0")), true);
assert.equal(
  wantsAppPrompt("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"),
  false,
  "no Android app to offer",
);
assert.equal(wantsAppPrompt("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"), false);
console.log("app prompt checks passed");
