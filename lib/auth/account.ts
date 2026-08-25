import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  ARENA_SESSION_COOKIE,
  ARENA_SESSION_COOKIE_OPTIONS,
} from "@/lib/arena/session";
import { hasSupabaseAuthCookie } from "@/lib/auth/cookies";

export { hasSupabaseAuthCookie } from "@/lib/auth/cookies";

export type PublicAccount = {
  id: string;
  email: string;
  displayName: string | null;
  isMineBenchAdmin: boolean;
  createdAt: Date;
};

type AccountSecurity = {
  account: PublicAccount;
  isPasswordRecovery: boolean;
  signedInWithPassword: boolean;
};

function authDisplayName(authUser: SupabaseAuthUser): string | null {
  for (const key of ["name", "full_name", "preferred_username", "user_name"]) {
    const value = authUser.user_metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return null;
}

export function hasAuthenticationMethod(amr: unknown, method: string): boolean {
  return Array.isArray(amr) && amr.some((entry) => {
    if (typeof entry === "string") return entry === method;
    if (!entry || typeof entry !== "object") return false;
    return "method" in entry && entry.method === method;
  });
}

export async function syncAuthUser(authUser: SupabaseAuthUser): Promise<PublicAccount | null> {
  const email = authUser.email?.trim().toLowerCase();
  if (!email) return null;
  const displayName = authDisplayName(authUser);

  return prisma.user.upsert({
    where: { id: authUser.id },
    create: {
      id: authUser.id,
      email,
      displayName,
      lastSeenAt: new Date(),
    },
    update: {
      email,
      lastSeenAt: new Date(),
      ...(displayName ? { displayName } : {}),
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      isMineBenchAdmin: true,
      createdAt: true,
    },
  });
}

export async function getCurrentAccount(): Promise<PublicAccount | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return syncAuthUser(user);
}

export async function getCurrentAccountSecurity(): Promise<AccountSecurity | null> {
  const supabase = await createSupabaseServerClient();
  const [userResult, claimsResult] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getClaims(),
  ]);
  const user = userResult.data.user;
  if (userResult.error || !user) return null;
  const account = await syncAuthUser(user);
  if (!account) return null;
  const amr = claimsResult.error ? null : claimsResult.data?.claims.amr;
  return {
    account,
    isPasswordRecovery: hasAuthenticationMethod(amr, "recovery"),
    signedInWithPassword: hasAuthenticationMethod(amr, "password"),
  };
}

export async function getAuthenticatedUserId(cookieHeader: string | null): Promise<string | null> {
  if (!hasSupabaseAuthCookie(cookieHeader)) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    const subject = data?.claims.sub;
    return !error && typeof subject === "string" && /^[0-9a-f-]{36}$/i.test(subject)
      ? subject
      : null;
  } catch {
    return null;
  }
}

export async function claimAnonymousPublicVotes(
  userId: string,
  sessionId: string | null,
): Promise<number> {
  if (!sessionId) return 0;
  const result = await prisma.vote.updateMany({
    where: {
      userId: null,
      sessionId,
      matchup: { stealthVariantId: null },
    },
    data: { userId },
  });
  return result.count;
}

export async function finishPublicSignIn(
  authUser: SupabaseAuthUser,
): Promise<{ account: PublicAccount; claimedVotes: number } | null> {
  const account = await syncAuthUser(authUser);
  if (!account) return null;

  const cookieStore = await cookies();
  const claimedVotes = await claimAnonymousPublicVotes(
    account.id,
    cookieStore.get(ARENA_SESSION_COOKIE)?.value ?? null,
  );
  cookieStore.set(ARENA_SESSION_COOKIE, crypto.randomUUID(), ARENA_SESSION_COOKIE_OPTIONS);
  return { account, claimedVotes };
}

export async function rotateArenaSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ARENA_SESSION_COOKIE, crypto.randomUUID(), ARENA_SESSION_COOKIE_OPTIONS);
}
