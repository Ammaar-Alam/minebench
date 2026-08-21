import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig, getSupabaseSecretKey } from "@/lib/supabase/config";

export function createSupabaseAdminClient() {
  const config = getSupabasePublicConfig();
  return createClient(config.url, getSupabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
