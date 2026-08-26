"use server";

import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  finishPublicSignIn,
  hasAuthenticationMethod,
  isPasswordRecoveryMethod,
  rotateArenaSession,
  syncAuthUser,
} from "@/lib/auth/account";
import { getRequestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const emailSchema = z.string().trim().email().max(320);
const passwordSchema = z.string().min(8).max(128);
const nameSchema = z.string().trim().max(120);

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function authRedirect(path: string, params: Record<string, string | undefined>): never {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  redirect(query.size ? `${path}?${query}` : path);
}

async function passwordRecoveryRedirect(): Promise<string> {
  const url = new URL("/auth/confirm", await getRequestOrigin());
  url.searchParams.set("next", "/reset-password");
  return url.toString();
}

export async function signInWithPassword(formData: FormData): Promise<never> {
  const next = safeNextPath(formString(formData, "next"), "/account");
  const parsed = z.object({
    email: emailSchema,
    password: passwordSchema,
  }).safeParse({
    email: formString(formData, "email"),
    password: formString(formData, "password"),
  });
  if (!parsed.success) authRedirect("/sign-in", { error: "credentials", next });

  let authUser: SupabaseAuthUser | null = null;
  let authError: "credentials" | "unavailable" = "credentials";
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email.toLowerCase(),
      password: parsed.data.password,
    });
    if (!error && data.user) authUser = data.user;
  } catch {
    authError = "unavailable";
  }
  if (!authUser) authRedirect("/sign-in", { error: authError, next });

  let finished;
  try {
    finished = await finishPublicSignIn(authUser);
  } catch {
    authRedirect("/sign-in", { error: "unavailable", next });
  }
  if (!finished) authRedirect("/sign-in", { error: "email-required", next });

  redirect(next);
}

export async function createAccount(formData: FormData): Promise<never> {
  const password = formString(formData, "password");
  const parsed = z.object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    passwordConfirm: passwordSchema,
  }).refine((value) => value.password === value.passwordConfirm, {
    path: ["passwordConfirm"],
  }).safeParse({
    name: formString(formData, "name"),
    email: formString(formData, "email"),
    password,
    passwordConfirm: formString(formData, "passwordConfirm"),
  });
  if (!parsed.success) authRedirect("/sign-up", { error: "details" });

  let authData: { user: SupabaseAuthUser; session: unknown | null } | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email.toLowerCase(),
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${await getRequestOrigin()}/auth/confirm`,
        ...(parsed.data.name ? { data: { name: parsed.data.name } } : {}),
      },
    });
    if (!error && data.user) authData = { user: data.user, session: data.session };
  } catch {}
  if (!authData) authRedirect("/sign-up", { error: "unavailable" });

  if (authData.session) {
    let finished;
    try {
      finished = await finishPublicSignIn(authData.user);
    } catch {
      authRedirect("/sign-up", { error: "unavailable" });
    }
    if (!finished) authRedirect("/sign-up", { error: "email-required" });
    redirect("/account?notice=created");
  }

  redirect("/sign-in?notice=confirm");
}

export async function requestPasswordReset(formData: FormData): Promise<never> {
  const parsed = emailSchema.safeParse(formString(formData, "email"));
  if (!parsed.success) authRedirect("/forgot-password", { error: "email" });

  let resetError = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(
      parsed.data.toLowerCase(),
      { redirectTo: await passwordRecoveryRedirect() },
    );
    resetError = Boolean(error);
  } catch {
    resetError = true;
  }
  if (resetError) authRedirect("/forgot-password", { error: "unavailable" });

  redirect("/forgot-password?notice=sent");
}

export async function requestPasswordSetup(): Promise<never> {
  let missingSession = false;
  let sendError = false;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user?.email) {
      missingSession = true;
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
        redirectTo: await passwordRecoveryRedirect(),
      });
      sendError = Boolean(error);
    }
  } catch {
    sendError = true;
  }
  if (missingSession) authRedirect("/sign-in", { next: "/account" });
  if (sendError) authRedirect("/reset-password", { error: "unavailable" });
  redirect("/account?notice=password-email");
}

export async function updatePassword(formData: FormData): Promise<never> {
  const parsed = z.object({
    password: passwordSchema,
    passwordConfirm: passwordSchema,
  }).refine((value) => value.password === value.passwordConfirm, {
    path: ["passwordConfirm"],
  }).safeParse({
    password: formString(formData, "password"),
    passwordConfirm: formString(formData, "passwordConfirm"),
  });
  if (!parsed.success) authRedirect("/reset-password", { error: "password" });

  const currentPassword = formString(formData, "currentPassword");
  let currentUser: SupabaseAuthUser | null = null;
  let missingSession = false;
  let updateError: "current-password" | "same-password" | "unavailable" | "verify" | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const [userResult, claimsResult] = await Promise.all([
      supabase.auth.getUser(),
      supabase.auth.getClaims(),
    ]);
    const user = userResult.data.user;
    if (userResult.error || !user) {
      missingSession = true;
    } else if (claimsResult.error) {
      updateError = "unavailable";
    } else {
      const amr = claimsResult.data?.claims.amr;
      const isRecovery = isPasswordRecoveryMethod(amr);
      const signedInWithPassword = hasAuthenticationMethod(amr, "password");
      if (!isRecovery && !signedInWithPassword) {
        updateError = "verify";
      } else if (signedInWithPassword && !currentPassword) {
        updateError = "current-password";
      } else {
        const { data, error } = await supabase.auth.updateUser({
          password: parsed.data.password,
          ...(signedInWithPassword ? { current_password: currentPassword } : {}),
        });
        if (!error && data.user) {
          currentUser = data.user;
        } else if (
          error?.code === "current_password_required" ||
          error?.code === "current_password_mismatch"
        ) {
          updateError = "current-password";
        } else if (error?.code === "same_password") {
          updateError = "same-password";
        } else {
          updateError = "unavailable";
        }
      }
    }
  } catch {
    updateError = "unavailable";
  }
  if (missingSession) authRedirect("/forgot-password", { error: "expired" });
  if (updateError) authRedirect("/reset-password", { error: updateError });
  if (!currentUser) authRedirect("/reset-password", { error: "unavailable" });

  try {
    await syncAuthUser(currentUser);
  } catch {
    authRedirect("/reset-password", { error: "unavailable" });
  }

  redirect("/account?notice=password");
}

export async function signOutAccount(): Promise<never> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } finally {
    await rotateArenaSession();
  }
  redirect("/sign-in?notice=signed-out");
}
