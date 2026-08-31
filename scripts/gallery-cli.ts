import { normalizeGalleryNickname } from "../lib/gallery/policy";
import { prisma } from "../lib/prisma";

const MINEBENCH_NICKNAME = "minebench";

export function galleryDatabaseTarget(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "unconfigured";
  }
}

export async function loadMineBenchGalleryPublisher() {
  const publisher = await prisma.user.findUnique({
    where: { publicNicknameNormalized: MINEBENCH_NICKNAME },
    select: {
      id: true,
      publicNickname: true,
      isMineBenchAdmin: true,
      gallerySuspendedAt: true,
      deletedAt: true,
      authDeletedAt: true,
    },
  });
  if (
    !publisher?.publicNickname ||
    !publisher.isMineBenchAdmin ||
    publisher.gallerySuspendedAt ||
    publisher.deletedAt ||
    publisher.authDeletedAt ||
    normalizeGalleryNickname(publisher.publicNickname).normalized !== MINEBENCH_NICKNAME
  ) {
    throw new Error("An active MineBench Gallery admin account is required.");
  }
  return publisher;
}
