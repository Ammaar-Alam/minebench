"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const emailSchema = z.string().trim().email().max(320);

async function requestOrigin(): Promise<string> {
  const configured = process.env.MINEBENCH_SITE_URL?.trim();
  if (configured) return new URL(configured).origin;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return new URL(`https://${vercelUrl}`).origin;
  if (process.env.NODE_ENV === "production") {
    throw new Error("Missing MINEBENCH_SITE_URL for the sign-in redirect");
  }

  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) throw new Error("Could not determine the sign-in origin");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

export async function requestLabMagicLink(formData: FormData) {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) redirect("/lab/sign-in?error=email");

  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signInWithOtp({
      email: parsed.data.toLowerCase(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${await requestOrigin()}/lab/auth/confirm?next=/lab`,
      },
    });
  } catch {
    // Keep invited and unknown addresses indistinguishable
  }

  redirect("/lab/sign-in?sent=1");
}

export async function signOutLab() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/lab/sign-in");
}
