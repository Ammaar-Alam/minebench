export function hasSupabaseAuthCookie(cookieHeader: string | null): boolean {
  return /(?:^|;\s*)sb-[^=;]+-auth-token(?:\.\d+)?=/.test(cookieHeader ?? "");
}
