import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { normalizeArenaBuildChecksum } from "@/lib/arena/buildChecksum";

type CompactArenaMatchupTokenPayload = {
  i: string;
  p: string;
  ma: string;
  mb: string;
  ba: string;
  bb: string;
  ca: string;
  cb: string;
  l?: string;
  r?: string;
  s?: string;
  t: number;
};

type CompactArenaBuildAccessTokenPayload = {
  b: string;
  c: string;
  t: number;
};

export type ArenaMatchupTokenPayload = {
  id: string;
  promptId: string;
  modelAId: string;
  modelBId: string;
  buildAId: string;
  buildBId: string;
  buildAChecksum: string;
  buildBChecksum: string;
  samplingLane?: string;
  samplingReason?: string;
  stealthVariantId?: string;
  issuedAt: number;
};

export type ArenaBuildAccessTokenPayload = {
  buildId: string;
  checksum: string;
  issuedAt: number;
};

const globalForArenaMatchupTokens = globalThis as typeof globalThis & {
  arenaMatchupDevSigningSecret?: string;
};

const TOKEN_VERSION = "v2";
const BUILD_ACCESS_TOKEN_VERSION = "b1";
const TOKEN_IV_BYTES = 12;
const DEFAULT_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TOKEN_FUTURE_SKEW_MS = 5 * 60 * 1000;

function configuredArenaMatchupSigningSecret(): string | null {
  return (
    [
      process.env.ARENA_MATCHUP_SIGNING_SECRET,
      process.env.ADMIN_TOKEN,
      process.env.NEXTAUTH_SECRET,
    ].find((value) => value?.trim())?.trim() ?? null
  );
}

export function hasArenaMatchupSigningSecret(): boolean {
  return configuredArenaMatchupSigningSecret() != null || process.env.NODE_ENV !== "production";
}

function getArenaMatchupSigningSecret(): string {
  const secret = configuredArenaMatchupSigningSecret();
  if (secret) return secret;

  if (process.env.NODE_ENV !== "production") {
    globalForArenaMatchupTokens.arenaMatchupDevSigningSecret ??= randomUUID();
    return globalForArenaMatchupTokens.arenaMatchupDevSigningSecret;
  }

  throw new Error(
    "ARENA_MATCHUP_SIGNING_SECRET, ADMIN_TOKEN, or NEXTAUTH_SECRET must be set for arena matchup tokens.",
  );
}

function arenaMatchupEncryptionKey(): Buffer {
  return createHash("sha256")
    .update("minebench:arena-matchup:v2\0")
    .update(getArenaMatchupSigningSecret())
    .digest();
}

function arenaBuildAccessEncryptionKey(): Buffer {
  return createHash("sha256")
    .update("minebench:arena-build-access:v1\0")
    .update(getArenaMatchupSigningSecret())
    .digest();
}

function tokenMaxAgeMs(): number {
  const parsed = Number.parseInt(process.env.ARENA_MATCHUP_TOKEN_MAX_AGE_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOKEN_MAX_AGE_MS;
  return Math.min(parsed, 24 * 60 * 60 * 1000);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signArenaMatchupPayload(encodedPayload: string): string {
  return createHmac("sha256", getArenaMatchupSigningSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function toCompactPayload(input: ArenaMatchupTokenPayload): CompactArenaMatchupTokenPayload {
  return {
    i: input.id,
    p: input.promptId,
    ma: input.modelAId,
    mb: input.modelBId,
    ba: input.buildAId,
    bb: input.buildBId,
    ca: input.buildAChecksum,
    cb: input.buildBChecksum,
    l: input.samplingLane,
    r: input.samplingReason,
    s: input.stealthVariantId,
    t: input.issuedAt,
  };
}

function fromCompactPayload(input: CompactArenaMatchupTokenPayload): ArenaMatchupTokenPayload | null {
  const buildAChecksum = normalizeArenaBuildChecksum(input.ca);
  const buildBChecksum = normalizeArenaBuildChecksum(input.cb);
  if (
    !input.i ||
    !input.p ||
    !input.ma ||
    !input.mb ||
    !input.ba ||
    !input.bb ||
    !buildAChecksum ||
    !buildBChecksum ||
    typeof input.t !== "number" ||
    !Number.isInteger(input.t) ||
    input.t > Date.now() + TOKEN_FUTURE_SKEW_MS ||
    Date.now() - input.t > tokenMaxAgeMs()
  ) {
    return null;
  }

  return {
    id: input.i,
    promptId: input.p,
    modelAId: input.ma,
    modelBId: input.mb,
    buildAId: input.ba,
    buildBId: input.bb,
    buildAChecksum,
    buildBChecksum,
    samplingLane: input.l,
    samplingReason: input.r,
    stealthVariantId: input.s,
    issuedAt: input.t,
  };
}

export function createArenaBuildAccessToken(input: {
  buildId: string;
  checksum: string;
}): string {
  const checksum = normalizeArenaBuildChecksum(input.checksum);
  if (!input.buildId.trim() || !checksum) {
    throw new Error("Arena build access tokens require a build id and SHA-256 checksum");
  }
  const payload: CompactArenaBuildAccessTokenPayload = {
    b: input.buildId,
    c: checksum,
    t: Date.now(),
  };
  const iv = randomBytes(TOKEN_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", arenaBuildAccessEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    BUILD_ACCESS_TOKEN_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function parseArenaBuildAccessToken(token: string): ArenaBuildAccessTokenPayload | null {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = token.trim().split(".");
  if (
    version !== BUILD_ACCESS_TOKEN_VERSION ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext ||
    extra
  ) {
    return null;
  }
  try {
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== TOKEN_IV_BYTES || tag.length !== 16 || ciphertext.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", arenaBuildAccessEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const payload = JSON.parse(plaintext) as CompactArenaBuildAccessTokenPayload;
    const checksum = normalizeArenaBuildChecksum(payload.c);
    if (
      !payload.b ||
      !checksum ||
      typeof payload.t !== "number" ||
      !Number.isInteger(payload.t) ||
      payload.t > Date.now() + TOKEN_FUTURE_SKEW_MS ||
      Date.now() - payload.t > tokenMaxAgeMs()
    ) {
      return null;
    }
    return { buildId: payload.b, checksum, issuedAt: payload.t };
  } catch {
    return null;
  }
}

export function createArenaMatchupToken(input: Omit<ArenaMatchupTokenPayload, "id" | "issuedAt">): string {
  const buildAChecksum = normalizeArenaBuildChecksum(input.buildAChecksum);
  const buildBChecksum = normalizeArenaBuildChecksum(input.buildBChecksum);
  if (!buildAChecksum || !buildBChecksum) {
    throw new Error("Arena matchup build checksums must be SHA-256 values");
  }
  const payload = toCompactPayload({
    ...input,
    buildAChecksum,
    buildBChecksum,
    id: randomUUID(),
    issuedAt: Date.now(),
  });
  const iv = randomBytes(TOKEN_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", arenaMatchupEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    TOKEN_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function parseArenaMatchupToken(token: string): ArenaMatchupTokenPayload | null {
  const trimmed = token.trim();
  if (trimmed.startsWith(`${TOKEN_VERSION}.`)) {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = trimmed.split(".");
    if (
      version !== TOKEN_VERSION ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra
    ) {
      return null;
    }
    try {
      const iv = Buffer.from(encodedIv, "base64url");
      const tag = Buffer.from(encodedTag, "base64url");
      const ciphertext = Buffer.from(encodedCiphertext, "base64url");
      if (iv.length !== TOKEN_IV_BYTES || tag.length !== 16 || ciphertext.length === 0) return null;
      const decipher = createDecipheriv("aes-256-gcm", arenaMatchupEncryptionKey(), iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return fromCompactPayload(JSON.parse(plaintext) as CompactArenaMatchupTokenPayload);
    } catch {
      return null;
    }
  }

  // Briefly accept unexpired v1 tokens so a deploy does not discard matchups already on screen
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex >= trimmed.length - 1) return null;

  const encodedPayload = trimmed.slice(0, dotIndex);
  const providedSignature = trimmed.slice(dotIndex + 1);
  const expectedSignature = signArenaMatchupPayload(encodedPayload);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as CompactArenaMatchupTokenPayload;
    return fromCompactPayload(parsed);
  } catch {
    return null;
  }
}
