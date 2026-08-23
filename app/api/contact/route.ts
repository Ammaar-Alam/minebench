import { handleContactPost } from "@/lib/contactRoute";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleContactPost(request);
}
