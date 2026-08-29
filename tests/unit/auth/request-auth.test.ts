import assert from "node:assert/strict";
import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import {
  getAuthenticatedAuthUser,
  getAuthenticatedUserId,
  type RequestAuthDependencies,
} from "../../../lib/auth/request";

const activeUserId = "34f9ac48-9913-4e6c-850c-b2d99605d390";
const deletedUserId = "1228822f-4b7b-41e0-b5e9-7e445b1599da";
const authUser = {
  id: activeUserId,
  email: "native-auth@example.test",
  app_metadata: { provider: "github", providers: ["github"] },
  user_metadata: {},
  aud: "authenticated",
  created_at: "2026-08-29T12:00:00.000Z",
} satisfies SupabaseAuthUser;

function dependencies(calls: string[]): RequestAuthDependencies {
  return {
    bearerSubject: async (token) => {
      calls.push(`bearer-subject:${token}`);
      return token === "valid-bearer" ? activeUserId : deletedUserId;
    },
    cookieSubject: async () => {
      calls.push("cookie-subject");
      return activeUserId;
    },
    bearerUser: async (token) => {
      calls.push(`bearer-user:${token}`);
      return token === "valid-bearer" ? authUser : null;
    },
    cookieUser: async () => {
      calls.push("cookie-user");
      return authUser;
    },
    activeUser: async (userId) => {
      calls.push(`active:${userId}`);
      return userId === activeUserId;
    },
  };
}

async function main() {
  let calls: string[] = [];
  assert.equal(
    await getAuthenticatedUserId(new Request("https://minebench.ai/api/account", {
      headers: {
        authorization: "Bearer valid-bearer",
        cookie: "sb-project-auth-token=cookie-session",
      },
    }), dependencies(calls)),
    activeUserId,
  );
  assert.deepEqual(calls, [
    "bearer-subject:valid-bearer",
    `active:${activeUserId}`,
  ]);

  calls = [];
  assert.equal(
    await getAuthenticatedUserId(new Request("https://minebench.ai/api/account", {
      headers: {
        authorization: "Basic invalid",
        cookie: "sb-project-auth-token=cookie-session",
      },
    }), dependencies(calls)),
    null,
  );
  assert.deepEqual(calls, [], "a malformed Authorization header must not downgrade to cookies");

  calls = [];
  assert.equal(
    await getAuthenticatedUserId(new Request("https://minebench.ai/api/account", {
      headers: { authorization: "Bearer deleted-bearer" },
    }), dependencies(calls)),
    null,
  );
  assert.deepEqual(calls, [
    "bearer-subject:deleted-bearer",
    `active:${deletedUserId}`,
  ]);

  calls = [];
  assert.equal(
    await getAuthenticatedUserId(new Request("https://minebench.ai/api/account", {
      headers: { cookie: "sb-project-auth-token=cookie-session" },
    }), dependencies(calls)),
    activeUserId,
  );
  assert.deepEqual(calls, ["cookie-subject", `active:${activeUserId}`]);

  calls = [];
  assert.equal(
    await getAuthenticatedUserId(new Request("https://minebench.ai/api/account", {
      headers: { cookie: "mb_session=anonymous" },
    }), dependencies(calls)),
    null,
  );
  assert.deepEqual(calls, []);

  calls = [];
  assert.equal(
    await getAuthenticatedAuthUser(new Request("https://minebench.ai/api/account/session", {
      headers: {
        authorization: "Bearer valid-bearer",
        cookie: "sb-project-auth-token=cookie-session",
      },
    }), dependencies(calls)),
    authUser,
  );
  assert.deepEqual(calls, ["bearer-user:valid-bearer"]);

  calls = [];
  assert.equal(
    await getAuthenticatedAuthUser(new Request("https://minebench.ai/api/account/session", {
      headers: { cookie: "sb-project-auth-token=cookie-session" },
    }), dependencies(calls)),
    authUser,
  );
  assert.deepEqual(calls, ["cookie-user"]);

  console.log("request authentication checks passed");
}

void main();
