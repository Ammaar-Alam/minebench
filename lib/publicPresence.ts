import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const PUBLIC_SESSION_ONLINE_MS = 10 * 60 * 1000;
export const PUBLIC_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type PublicSessionLocation = {
  city?: string | null;
  countryRegion?: string | null;
  country?: string | null;
};

function clean(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = value?.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

export function cleanPublicSessionLocation(location: PublicSessionLocation) {
  return {
    city: clean(location.city, 160),
    countryRegion: clean(location.countryRegion, 64),
    country: clean(location.country, 8),
  };
}

export async function touchPublicSessionActivity(input: {
  sessionId: string;
  userId: string | null;
  ipHmac?: string | null;
  location?: PublicSessionLocation;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const location = cleanPublicSessionLocation(input.location ?? {});
  const data = {
    userId: input.userId,
    ipHmac: input.ipHmac ?? null,
    lastSeenAt: now,
    ...location,
  };
  try {
    return await prisma.publicSessionActivity.upsert({
      where: { sessionId: input.sessionId },
      create: { sessionId: input.sessionId, ...data },
      update: data,
      select: { id: true },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2003") {
      throw error;
    }
    return prisma.publicSessionActivity.upsert({
      where: { sessionId: input.sessionId },
      create: { sessionId: input.sessionId, ...data, userId: null },
      update: { ...data, userId: null },
      select: { id: true },
    });
  }
}
