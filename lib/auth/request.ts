import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { hasSupabaseAuthCookie } from "@/lib/auth/cookies";
import { prisma } from "@/lib/prisma";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RequestAuthDependencies = {
  bearerSubject: (token: string) => Promise<string | null>;
  cookieSubject: () => Promise<string | null>;
  bearerUser: (token: string) => Promise<SupabaseAuthUser | null>;
  cookieUser: () => Promise<SupabaseAuthUser | null>;
  activeUser: (userId: string) => Promise<boolean>;
};

function createBearerClient() {
  const config = getSupabasePublicConfig();
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

const defaultDependencies: RequestAuthDependencies = {
  bearerSubject: async (token) => {
    const { data, error } = await createBearerClient().auth.getClaims(token);
    return !error && typeof data?.claims.sub === "string" ? data.claims.sub : null;
  },
  cookieSubject: async () => {
    const { data, error } = await (await createSupabaseServerClient()).auth.getClaims();
    return !error && typeof data?.claims.sub === "string" ? data.claims.sub : null;
  },
  bearerUser: async (token) => {
    const { data, error } = await createBearerClient().auth.getUser(token);
    return error ? null : data.user;
  },
  cookieUser: async () => {
    const { data, error } = await (await createSupabaseServerClient()).auth.getUser();
    return error ? null : data.user;
  },
  activeUser: async (userId) => Boolean(await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true },
  })),
};

function bearerToken(request: Request): string | null | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function validSubject(subject: string | null): subject is string {
  return Boolean(subject && UUID_PATTERN.test(subject));
}

export async function getAuthenticatedUserId(
  request: Request,
  dependencies: RequestAuthDependencies = defaultDependencies,
): Promise<string | null> {
  try {
    const token = bearerToken(request);
    const subject = token === undefined
      ? hasSupabaseAuthCookie(request.headers.get("cookie"))
        ? await dependencies.cookieSubject()
        : null
      : token
        ? await dependencies.bearerSubject(token)
        : null;
    if (!validSubject(subject)) return null;
    return await dependencies.activeUser(subject) ? subject : null;
  } catch {
    return null;
  }
}

export async function getAuthenticatedAuthUser(
  request: Request,
  dependencies: RequestAuthDependencies = defaultDependencies,
): Promise<SupabaseAuthUser | null> {
  try {
    const token = bearerToken(request);
    const user = token === undefined
      ? hasSupabaseAuthCookie(request.headers.get("cookie"))
        ? await dependencies.cookieUser()
        : null
      : token
        ? await dependencies.bearerUser(token)
        : null;
    return user && validSubject(user.id) ? user : null;
  } catch {
    return null;
  }
}
