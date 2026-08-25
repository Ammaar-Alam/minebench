import { NextRequest, NextResponse } from "next/server";
import { finishPublicSignIn } from "@/lib/auth/account";
import { getRequestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const origin = await getRequestOrigin();
  const next = safeNextPath(request.nextUrl.searchParams.get("next"), "/account");
  const errorUrl = new URL("/sign-in?error=oauth", origin);
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(errorUrl);

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user) return NextResponse.redirect(errorUrl);
    const finished = await finishPublicSignIn(data.user);
    if (!finished) {
      errorUrl.searchParams.set("error", "email-required");
      return NextResponse.redirect(errorUrl);
    }
    return NextResponse.redirect(new URL(next, origin), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.redirect(errorUrl);
  }
}
