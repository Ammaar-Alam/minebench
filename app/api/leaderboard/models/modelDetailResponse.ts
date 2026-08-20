import { NextResponse } from "next/server";
import type { ModelDetailStats } from "@/lib/arena/stats";

export function createModelDetailResponse(data: ModelDetailStats | null) {
  if (!data) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
