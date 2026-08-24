import dns from "node:dns/promises";
import net from "node:net";

// Resolves and validates user-supplied custom API endpoints before any request
// leaves the server: URL shape, credential and localhost bans, DNS resolution,
// and private/reserved address rejection to prevent SSRF

export type ResolvedCustomApiTarget = {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
};

function normalizeBaseUrl(raw?: string): string {
  const candidate = raw ?? process.env.CUSTOM_API_BASE_URL;
  if (!candidate) {
    throw new Error("Missing custom API server URL");
  }
  const base = candidate
    .trim()
    .replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) {
    return base.slice(0, -"/chat/completions".length);
  }
  return base;
}

function buildChatCompletionsUrl(raw?: string): URL {
  const base = normalizeBaseUrl(raw);
  return new URL(base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`);
}

function normalizeIpAddress(address: string): string {
  const normalized = address.trim().replace(/^\[(.*)\]$/, "$1");
  const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
  if (embeddedIpv4) {
    return embeddedIpv4;
  }
  return normalized;
}

function expandIpv6Hextets(address: string): string[] | null {
  const normalized = address.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (net.isIP(normalized) !== 6) return null;

  let candidate = normalized;
  if (candidate.includes(".")) {
    const lastColon = candidate.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4Part = candidate.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    candidate = `${candidate.slice(0, lastColon)}:${high}:${low}`;
  }

  const hasCompression = candidate.includes("::");
  if (hasCompression && candidate.indexOf("::") !== candidate.lastIndexOf("::")) {
    return null;
  }

  const [leftRaw = "", rightRaw = ""] = candidate.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const isHex = (part: string) => /^[0-9a-f]{1,4}$/.test(part);
  if (left.some((part) => !isHex(part)) || right.some((part) => !isHex(part))) {
    return null;
  }

  if (!hasCompression) {
    if (left.length !== 8) return null;
    return left.map((part) => part.padStart(4, "0"));
  }

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [
    ...left.map((part) => part.padStart(4, "0")),
    ...Array.from({ length: missing }, () => "0000"),
    ...right.map((part) => part.padStart(4, "0")),
  ];
}

function extractEmbeddedIpv4FromIpv6(address: string): string | null {
  const hextets = expandIpv6Hextets(address);
  if (!hextets) return null;

  const isCompatible =
    hextets.slice(0, 6).every((part) => part === "0000");
  const isMapped =
    hextets.slice(0, 5).every((part) => part === "0000") && hextets[5] === "ffff";
  if (!isCompatible && !isMapped) return null;

  const high = Number.parseInt(hextets[6], 16);
  const low = Number.parseInt(hextets[7], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isDisallowedIpAddress(address: string): boolean {
  const normalizedAddress = normalizeIpAddress(address);
  const family = net.isIP(normalizedAddress);
  if (family === 4) {
    const parts = normalizedAddress.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && parts[2] === 100) ||
      (a === 203 && b === 0 && parts[2] === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = normalizedAddress.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8")
    );
  }
  return true;
}

function isDnsLookupError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  return (
    "code" in error &&
    (error.code === "ENOTFOUND" ||
      error.code === "EAI_AGAIN" ||
      error.code === "ENODATA" ||
      error.code === "ESERVFAIL")
  );
}

export async function resolveCustomApiTarget(rawUrl: string): Promise<ResolvedCustomApiTarget> {
  if (!rawUrl.trim()) {
    throw new Error("Missing custom API server URL");
  }

  let url: URL;
  try {
    url = buildChatCompletionsUrl(rawUrl);
  } catch {
    throw new Error("Invalid custom API server URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Custom API server URL must use http or https");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Custom API server URL must use https in production");
  }
  if (url.username || url.password) {
    throw new Error("Custom API server URL must not include embedded credentials");
  }

  const hostname = normalizeIpAddress(url.hostname.trim().toLowerCase());
  if (!hostname) {
    throw new Error("Custom API server URL is missing a hostname");
  }
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Custom API server URL must not target localhost or local network hosts");
  }
  if (!hostname.includes(".") && net.isIP(hostname) === 0) {
    throw new Error("Custom API server URL must use a public hostname");
  }

  const hostFamily = net.isIP(hostname);
  if (hostFamily !== 0) {
    const normalizedAddress = normalizeIpAddress(hostname);
    if (isDisallowedIpAddress(normalizedAddress)) {
      throw new Error("Custom API server URL must not target private or loopback IPs");
    }
    return {
      url,
      hostname,
      address: normalizedAddress,
      family: net.isIP(normalizedAddress) as 4 | 6,
    };
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error("Custom API server URL hostname did not resolve");
    }

    const normalizedRecords = records.map((record) => ({
      address: normalizeIpAddress(record.address),
      family: net.isIP(normalizeIpAddress(record.address)),
    }));
    if (normalizedRecords.some((record) => record.family === 0 || isDisallowedIpAddress(record.address))) {
      throw new Error("Custom API server URL resolved to a private or loopback address");
    }

    const selected = normalizedRecords[0];
    if (!selected) {
      throw new Error("Custom API server URL hostname did not resolve");
    }

    return {
      url,
      hostname,
      address: selected.address,
      family: selected.family as 4 | 6,
    };
  } catch (error) {
    if (isDnsLookupError(error)) {
      throw new Error("Custom API server URL hostname did not resolve");
    }
    if (error instanceof Error) throw error;
    throw new Error("Failed to validate custom API server URL");
  }
}

export async function assertSafeCustomApiUrl(rawUrl: string): Promise<void> {
  await resolveCustomApiTarget(rawUrl);
}
