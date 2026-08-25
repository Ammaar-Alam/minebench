import type { Provider } from "@supabase/supabase-js";

export const PUBLIC_OAUTH_PROVIDERS = ["google", "github", "discord", "x"] as const;
export type PublicOAuthProvider = (typeof PUBLIC_OAUTH_PROVIDERS)[number];

export function parsePublicOAuthProvider(value: string | null): Provider | null {
  return PUBLIC_OAUTH_PROVIDERS.includes(value as PublicOAuthProvider)
    ? (value as PublicOAuthProvider)
    : null;
}
