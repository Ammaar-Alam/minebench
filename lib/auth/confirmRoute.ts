import type { EmailOtpType, User as SupabaseAuthUser } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { finishPublicSignIn } from "@/lib/auth/account";
import { getRequestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ConfirmExchangeResult = {
  data: { user: SupabaseAuthUser | null };
  error: unknown | null;
};

export type ConfirmSupabaseClient = {
  auth: {
    exchangeCodeForSession: (code: string) => Promise<ConfirmExchangeResult>;
    verifyOtp: (args: { token_hash: string; type: EmailOtpType }) => Promise<ConfirmExchangeResult>;
  };
};

export type ConfirmRouteDependencies = {
  origin: string;
  createClient: () => Promise<ConfirmSupabaseClient>;
  finishSignIn: (user: SupabaseAuthUser) => Promise<unknown>;
};

export async function handleConfirmGet(
  request: Request,
  dependencies: ConfirmRouteDependencies,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const isRecovery =
    type === "recovery" ||
    safeNextPath(url.searchParams.get("next"), "") === "/reset-password";
  const fallback = isRecovery ? "/reset-password" : "/account";
  const next = safeNextPath(url.searchParams.get("next"), fallback);
  const errorUrl = new URL(
    isRecovery ? "/forgot-password?error=expired" : "/sign-in?error=link",
    dependencies.origin,
  );

  try {
    const supabase = await dependencies.createClient();
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : tokenHash && type
        ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
        : null;
    if (!result || result.error || !result.data.user) return NextResponse.redirect(errorUrl);
    const finished = await dependencies.finishSignIn(result.data.user);
    if (!finished) {
      return NextResponse.redirect(new URL("/sign-in?error=email-required", dependencies.origin));
    }
    return NextResponse.redirect(new URL(next, dependencies.origin), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.redirect(errorUrl);
  }
}

export async function createConfirmRouteDependencies(): Promise<ConfirmRouteDependencies> {
  return {
    origin: await getRequestOrigin(),
    createClient: async () => {
      const supabase = await createSupabaseServerClient();
      return {
        auth: {
          exchangeCodeForSession: (code) => supabase.auth.exchangeCodeForSession(code),
          verifyOtp: (args) => supabase.auth.verifyOtp(args),
        },
      };
    },
    finishSignIn: finishPublicSignIn,
  };
}
