import type { EmailOtpType } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { finishPublicSignIn } from "@/lib/auth/account";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function safeNextPath(value: string | null): string {
  return value?.startsWith("/lab") && !value.startsWith("//") ? value : "/lab";
}

export async function GET(request: NextRequest) {
  const redirectTo = request.nextUrl.clone();
  redirectTo.pathname = safeNextPath(request.nextUrl.searchParams.get("next"));
  redirectTo.search = "";

  try {
    const supabase = await createSupabaseServerClient();
    const code = request.nextUrl.searchParams.get("code");
    const tokenHash = request.nextUrl.searchParams.get("token_hash");
    const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : tokenHash && type
        ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
        : null;

    if (result && !result.error && result.data.user) {
      const finished = await finishPublicSignIn(result.data.user);
      if (finished) {
        return NextResponse.redirect(redirectTo, {
          headers: { "Cache-Control": "private, no-store" },
        });
      }
    }
  } catch {}

  redirectTo.pathname = "/lab/sign-in";
  redirectTo.searchParams.set("error", "link");
  return NextResponse.redirect(redirectTo, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
