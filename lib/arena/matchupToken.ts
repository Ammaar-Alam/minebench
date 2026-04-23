import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

type CompactArenaMatchupTokenPayload = {
  i: string;
  p: string;
  ma: string;
  mb: string;
  ba: string;
  bb: string;
  l?: string;
  r?: string;
  t: number;
};

export type ArenaMatchupTokenPayload = {
  id: string;
  promptId: string;
  modelAId: string;
  modelBId: string;
  buildAId: string;
  buildBId: string;
  samplingLane?: string;
  samplingReason?: string;
  issuedAt: number;
};

function getArenaMatchupSigningSecret(): string {
  return (
    process.env.ARENA_MATCHUP_SIGNING_SECRET ??
    process.env.ADMIN_TOKEN ??
    process.env.NEXTAUTH_SECRET ??
    "dev-arena-matchup-secret"
  );
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
    l: input.samplingLane,
    r: input.samplingReason,
    t: input.issuedAt,
  };
}

function fromCompactPayload(input: CompactArenaMatchupTokenPayload): ArenaMatchupTokenPayload | null {
  if (
    !input.i ||
    !input.p ||
    !input.ma ||
    !input.mb ||
    !input.ba ||
    !input.bb ||
    typeof input.t !== "number"
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
    samplingLane: input.l,
    samplingReason: input.r,
    issuedAt: input.t,
  };
}

export function createArenaMatchupToken(input: Omit<ArenaMatchupTokenPayload, "id" | "issuedAt">): string {
  const payload = toCompactPayload({
    ...input,
    id: randomUUID(),
    issuedAt: Date.now(),
  });
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signArenaMatchupPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function parseArenaMatchupToken(token: string): ArenaMatchupTokenPayload | null {
  const trimmed = token.trim();
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
