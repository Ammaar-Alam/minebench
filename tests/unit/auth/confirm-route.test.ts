import assert from "node:assert/strict";
import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import {
  handleConfirmGet,
  type ConfirmExchangeResult,
  type ConfirmRouteDependencies,
} from "../../../lib/auth/confirmRoute";

const ORIGIN = "https://minebench.invalid";

const authUser = {
  id: "34f9ac48-9913-4e6c-850c-b2d99605d390",
  email: "recovery@example.test",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  aud: "authenticated",
  created_at: "2026-09-05T00:00:00.000Z",
} satisfies SupabaseAuthUser;

const expiredResult: ConfirmExchangeResult = { data: { user: null }, error: new Error("expired") };
const okResult: ConfirmExchangeResult = { data: { user: authUser }, error: null };

type DepsOptions = {
  exchangeResult?: ConfirmExchangeResult;
  verifyResult?: ConfirmExchangeResult;
  finishResult?: unknown;
};

function makeDeps(options: DepsOptions = {}): { deps: ConfirmRouteDependencies; calls: string[] } {
  const calls: string[] = [];
  const exchangeResult = options.exchangeResult ?? expiredResult;
  const verifyResult = options.verifyResult ?? exchangeResult;
  const deps: ConfirmRouteDependencies = {
    origin: ORIGIN,
    createClient: async () => ({
      auth: {
        exchangeCodeForSession: async (code) => {
          calls.push(`exchange:${code}`);
          return exchangeResult;
        },
        verifyOtp: async (args) => {
          calls.push(`verify:${args.token_hash}:${args.type}`);
          return verifyResult;
        },
      },
    }),
    finishSignIn: async (user) => {
      calls.push(`finish:${user.id}`);
      return options.finishResult === undefined ? { ok: true } : options.finishResult;
    },
  };
  return { deps, calls };
}

function confirmRequest(query: string): Request {
  return new Request(`${ORIGIN}/auth/confirm${query}`);
}

function location(response: Response): string {
  return response.headers.get("location") ?? "";
}

async function main() {
  {
    const { deps, calls } = makeDeps();
    const response = await handleConfirmGet(confirmRequest("?code=expired&next=/reset-password"), deps);
    assert.equal(location(response), `${ORIGIN}/forgot-password?error=expired`);
    assert.deepEqual(calls, ["exchange:expired"]);
  }

  {
    const { deps, calls } = makeDeps();
    const response = await handleConfirmGet(confirmRequest("?token_hash=hash&type=recovery"), deps);
    assert.equal(location(response), `${ORIGIN}/forgot-password?error=expired`);
    assert.deepEqual(calls, ["verify:hash:recovery"]);
  }

  {
    const { deps, calls } = makeDeps();
    const response = await handleConfirmGet(confirmRequest("?code=expired&next=/account"), deps);
    assert.equal(location(response), `${ORIGIN}/sign-in?error=link`);
    assert.deepEqual(calls, ["exchange:expired"]);
  }

  {
    const { deps, calls } = makeDeps({ exchangeResult: okResult });
    const response = await handleConfirmGet(confirmRequest("?code=valid&next=/reset-password"), deps);
    assert.equal(location(response), `${ORIGIN}/reset-password`);
    assert.deepEqual(calls, ["exchange:valid", `finish:${authUser.id}`]);
  }

  {
    const { deps, calls } = makeDeps({ exchangeResult: okResult });
    const response = await handleConfirmGet(confirmRequest("?code=valid"), deps);
    assert.equal(location(response), `${ORIGIN}/account`);
    assert.deepEqual(calls, ["exchange:valid", `finish:${authUser.id}`]);
  }

  {
    const { deps } = makeDeps();
    const response = await handleConfirmGet(
      confirmRequest("?code=expired&next=https://attacker.test/reset-password"),
      deps,
    );
    assert.equal(location(response), `${ORIGIN}/sign-in?error=link`);
  }

  {
    const { deps } = makeDeps({ exchangeResult: okResult, finishResult: null });
    const response = await handleConfirmGet(confirmRequest("?code=valid&next=/reset-password"), deps);
    assert.equal(location(response), `${ORIGIN}/sign-in?error=email-required`);
  }

  {
    const { deps, calls } = makeDeps({ exchangeResult: okResult, verifyResult: okResult });
    const response = await handleConfirmGet(
      confirmRequest("?code=valid&token_hash=hash&type=recovery&next=/account"),
      deps,
    );
    assert.equal(location(response), `${ORIGIN}/account`);
    assert.deepEqual(calls, ["exchange:valid", `finish:${authUser.id}`]);
  }

  {
    const { deps, calls } = makeDeps();
    const response = await handleConfirmGet(
      confirmRequest("?token_hash=hash&type=recovery&next=/account"),
      deps,
    );
    assert.equal(location(response), `${ORIGIN}/forgot-password?error=expired`);
    assert.deepEqual(calls, ["verify:hash:recovery"]);
  }

  console.log("auth confirm route checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
