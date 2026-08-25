import type { EmailOtpType } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { finishPublicSignIn } from "@/lib/auth/account";
import { getRequestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const origin = await getRequestOrigin();
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const fallback = type === "recovery" ? "/reset-password" : "/account";
  const next = safeNextPath(request.nextUrl.searchParams.get("next"), fallback);
  const errorUrl = new URL(
    type === "recovery" ? "/forgot-password?error=expired" : "/sign-in?error=link",
    origin,
  );

  try {
    const supabase = await createSupabaseServerClient();
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : tokenHash && type
        ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
        : null;
    if (!result || result.error || !result.data.user) return NextResponse.redirect(errorUrl);
    const finished = await finishPublicSignIn(result.data.user);
    if (!finished) return NextResponse.redirect(new URL("/sign-in?error=email-required", origin));
    return NextResponse.redirect(new URL(next, origin), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.redirect(errorUrl);
  }
}
