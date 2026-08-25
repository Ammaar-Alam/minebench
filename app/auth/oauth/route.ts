import { NextRequest, NextResponse } from "next/server";
import { parsePublicOAuthProvider } from "@/lib/auth/providers";
import { getRequestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const provider = parsePublicOAuthProvider(request.nextUrl.searchParams.get("provider"));
  const next = safeNextPath(request.nextUrl.searchParams.get("next"), "/account");
  const errorUrl = new URL("/sign-in", await getRequestOrigin());
  errorUrl.searchParams.set("error", "oauth");
  if (!provider) return NextResponse.redirect(errorUrl);

  try {
    const supabase = await createSupabaseServerClient();
    const callbackUrl = new URL("/auth/callback", await getRequestOrigin());
    callbackUrl.searchParams.set("next", next);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: callbackUrl.toString() },
    });
    if (error || !data.url) return NextResponse.redirect(errorUrl);
    return NextResponse.redirect(data.url, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.redirect(errorUrl);
  }
}
