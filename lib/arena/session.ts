export const ARENA_SESSION_COOKIE = "mb_session";

export const ARENA_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

export function readArenaSessionId(cookieHeader: string | null): string | null {
  const match = (cookieHeader ?? "").match(
    new RegExp(`(?:^|;\\s*)${ARENA_SESSION_COOKIE}=([^;]+)`),
  );
  return match?.[1]?.trim() || null;
}

export function appendArenaSessionCookie(response: Response, sessionId: string): void {
  response.headers.append(
    "Set-Cookie",
    `${ARENA_SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${ARENA_SESSION_COOKIE_OPTIONS.maxAge}; HttpOnly; SameSite=Lax${ARENA_SESSION_COOKIE_OPTIONS.secure ? "; Secure" : ""}`,
  );
}
