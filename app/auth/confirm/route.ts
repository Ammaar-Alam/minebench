import { NextRequest } from "next/server";
import { createConfirmRouteDependencies, handleConfirmGet } from "@/lib/auth/confirmRoute";

export async function GET(request: NextRequest) {
  return handleConfirmGet(request, await createConfirmRouteDependencies());
}
