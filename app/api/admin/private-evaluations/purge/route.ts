import { NextResponse } from "next/server";
import { purgeDueStealthEvaluations } from "@/lib/stealth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizationError(request: Request): string | null {
  const allowed = [process.env.ADMIN_TOKEN, process.env.CRON_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (allowed.length === 0) return "Missing ADMIN_TOKEN or CRON_SECRET on server";
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) return "Authorization required";
  return allowed.includes(match[1].trim()) ? null : "Invalid authorization";
}

export async function GET(request: Request) {
  const authError = authorizationError(request);
  if (authError) return NextResponse.json({ error: authError }, { status: 401 });

  const result = await purgeDueStealthEvaluations({ minebenchAdmin: true });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
