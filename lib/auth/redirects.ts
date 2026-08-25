import { headers } from "next/headers";

const URL_BASE = "https://minebench.invalid";

export function safeNextPath(value: string | null | undefined, fallback = "/account"): string {
  if (!value?.startsWith("/")) return fallback;
  try {
    const parsed = new URL(value, URL_BASE);
    if (parsed.origin !== URL_BASE) return fallback;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
}

export function resolveRequestOrigin(input: {
  configuredOrigin?: string;
  vercelUrl?: string;
  nodeEnv?: string;
  forwardedHost?: string | null;
  host?: string | null;
  forwardedProto?: string | null;
}): string {
  if (input.configuredOrigin?.trim()) {
    return new URL(input.configuredOrigin.trim()).origin;
  }
  if (input.vercelUrl?.trim()) {
    return new URL(`https://${input.vercelUrl.trim()}`).origin;
  }
  if (input.nodeEnv === "production") {
    throw new Error("Missing MINEBENCH_SITE_URL for the authentication redirect");
  }

  const host = input.forwardedHost?.trim() || input.host?.trim();
  if (!host) throw new Error("Could not determine the authentication origin");
  const protocol = input.forwardedProto?.trim() || (host.startsWith("localhost") ? "http" : "https");
  return new URL(`${protocol}://${host}`).origin;
}

export async function getRequestOrigin(): Promise<string> {
  const requestHeaders = await headers();
  return resolveRequestOrigin({
    configuredOrigin: process.env.MINEBENCH_SITE_URL,
    vercelUrl: process.env.VERCEL_URL,
    nodeEnv: process.env.NODE_ENV,
    forwardedHost: requestHeaders.get("x-forwarded-host"),
    host: requestHeaders.get("host"),
    forwardedProto: requestHeaders.get("x-forwarded-proto"),
  });
}
