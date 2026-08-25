import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  hasAuthenticationMethod,
  hasSupabaseAuthCookie,
} from "../../../lib/auth/account";
import { parsePublicOAuthProvider } from "../../../lib/auth/providers";
import { resolveRequestOrigin, safeNextPath } from "../../../lib/auth/redirects";
import { readArenaSessionId } from "../../../lib/arena/session";

assert.equal(safeNextPath("/account?tab=rankings"), "/account?tab=rankings");
assert.equal(safeNextPath("https://attacker.test/account"), "/account");
assert.equal(safeNextPath("//attacker.test/account"), "/account");
assert.equal(safeNextPath("/\\attacker.test/account"), "/account");
assert.equal(safeNextPath(null, "/"), "/");

assert.equal(parsePublicOAuthProvider("google"), "google");
assert.equal(parsePublicOAuthProvider("github"), "github");
assert.equal(parsePublicOAuthProvider("discord"), "discord");
assert.equal(parsePublicOAuthProvider("x"), "x");
assert.equal(parsePublicOAuthProvider("twitter"), null, "legacy OAuth 1.0a must stay disabled");

assert.equal(
  resolveRequestOrigin({ configuredOrigin: "https://minebench.ai/path" }),
  "https://minebench.ai",
);
assert.equal(
  resolveRequestOrigin({ vercelUrl: "minebench-alpha.vercel.app" }),
  "https://minebench-alpha.vercel.app",
);
assert.equal(
  resolveRequestOrigin({ nodeEnv: "development", host: "localhost:3000" }),
  "http://localhost:3000",
);
assert.throws(
  () => resolveRequestOrigin({ nodeEnv: "production", host: "untrusted.test" }),
  /Missing MINEBENCH_SITE_URL/,
);

assert.equal(hasSupabaseAuthCookie("theme=dark; sb-project-auth-token=value"), true);
assert.equal(hasSupabaseAuthCookie("sb-project-auth-token.0=value"), true);
assert.equal(hasSupabaseAuthCookie("mb_session=value"), false);
assert.equal(hasAuthenticationMethod([{ method: "password", timestamp: 1 }], "password"), true);
assert.equal(hasAuthenticationMethod(["recovery"], "recovery"), true);
assert.equal(hasAuthenticationMethod([{ method: "oauth", timestamp: 1 }], "password"), false);
assert.equal(readArenaSessionId("a=1; mb_session=session-123; b=2"), "session-123");
assert.equal(readArenaSessionId("a=1"), null);

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260825120000_public_vote_ownership/migration.sql",
  "utf8",
);
assert.match(schema, /userId String\? @db\.Uuid/);
assert.match(schema, /@@index\(\[userId, createdAt\]\)/);
assert.match(migration, /ON DELETE SET NULL/);

const actions = readFileSync("app/(auth)/actions.ts", "utf8");
for (const method of [
  "signUp",
  "signInWithPassword",
  "resetPasswordForEmail",
  "updateUser",
  "signOut",
]) {
  assert.match(actions, new RegExp(`auth\\.${method}`));
}
assert.match(actions, /finishPublicSignIn/);
assert.match(actions, /current_password: currentPassword/);
assert.match(actions, /resetPasswordForEmail\(user\.email/);
const signUpPage = readFileSync("app/(auth)/sign-up/page.tsx", "utf8");
assert.match(signUpPage, /Confirm password/);
assert.doesNotMatch(signUpPage, /sm:grid-cols-2/);

const passwordInput = readFileSync("components/auth/PasswordInput.tsx", "utf8");
assert.match(passwordInput, /Show password/);
assert.match(passwordInput, /Hide password/);

const authShell = readFileSync("components/auth/AuthShell.tsx", "utf8");
assert.match(authShell, /provider: "github", label: "GitHub"/);

const resetPasswordPage = readFileSync("app/(auth)/reset-password/page.tsx", "utf8");
assert.match(resetPasswordPage, /Current password/);
assert.match(resetPasswordPage, /Verify your email first/);

const accountPage = readFileSync("app/account/page.tsx", "utf8");
assert.match(accountPage, /<Suspense fallback={<PersonalRankingSkeleton \/>}>/);
assert.match(accountPage, /id="ranking-title"/);
assert.equal(existsSync("app/account/loading.tsx"), false);

const personalRankingView = readFileSync("app/account/PersonalRanking.tsx", "utf8");
assert.match(personalRankingView, /max-h-\[min\(32rem,55dvh\)\]/);
assert.match(personalRankingView, /sticky top-0/);
assert.match(personalRankingView, /overflow-y-auto/);
assert.doesNotMatch(personalRankingView, /Ties count|Early signal/);

const oauthRoute = readFileSync("app/auth/oauth/route.ts", "utf8");
const callbackRoute = readFileSync("app/auth/callback/route.ts", "utf8");
const confirmRoute = readFileSync("app/auth/confirm/route.ts", "utf8");
assert.match(oauthRoute, /signInWithOAuth/);
assert.match(callbackRoute, /exchangeCodeForSession/);
assert.match(confirmRoute, /verifyOtp/);

const voteRoute = readFileSync("app/api/arena/vote/route.ts", "utf8");
assert.match(voteRoute, /!matchup\.stealthVariantId && authUserId/);
assert.match(voteRoute, /getAuthenticatedUserId/);
assert.match(voteRoute, /logArenaVoteRequest/);

const personalRanking = readFileSync("lib/account/personalRanking.ts", "utf8");
assert.match(personalRanking, /matchup\."stealthVariantId" IS NULL/);
assert.match(personalRanking, /vote\.choice IN \('A', 'B', 'TIE'\)/);
assert.doesNotMatch(personalRanking, /prisma\.vote\.count/);
assert.doesNotMatch(personalRanking, /prisma\.model\.update|prisma\.vote\.update/);

console.log("public authentication contract checks passed");
