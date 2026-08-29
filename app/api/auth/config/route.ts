import { getSupabasePublicConfig } from "@/lib/supabase/config";

export const runtime = "nodejs";

export async function GET() {
  const config = getSupabasePublicConfig();
  return Response.json(
    {
      supabaseUrl: config.url,
      publishableKey: config.publishableKey,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    },
  );
}
