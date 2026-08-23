import { NextResponse } from "next/server";
import {
  clientMetricBatchSchema,
  emitClientCustomMetrics,
} from "@/lib/observability/customMetrics";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

function isSameOriginRequest(request: Request): boolean {
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (!candidate) return false;

  try {
    return new URL(candidate).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      !isSameOriginRequest(request) ||
      (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site")
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid metrics payload" }, { status: 400 });
  }
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid metrics payload" }, { status: 400 });
  }
  const parsed = clientMetricBatchSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid metrics payload" }, { status: 400 });
  }

  emitClientCustomMetrics(parsed.data.samples);
  return new Response(null, { status: 204 });
}
