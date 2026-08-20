import { NextResponse } from "next/server";
import { FAQ_SECTIONS } from "@/lib/faq";

export function GET() {
  return NextResponse.json(
    { sections: FAQ_SECTIONS },
    {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
