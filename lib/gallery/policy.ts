import { createHmac } from "node:crypto";
import {
  englishDataset,
  englishRecommendedTransformers,
  RegExpMatcher,
} from "obscenity";

const publicTextMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export type GalleryCursor = {
  score: number;
  publishedAt: Date;
  id: string;
};

export function normalizeGalleryPrompt(value: string): string {
  return value.trim();
}

export function normalizeGalleryNickname(value: string): {
  display: string;
  normalized: string;
} {
  const display = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return { display, normalized: display.toLocaleLowerCase("en-US") };
}

export function publicGalleryTextError(value: string): "blocked_language" | null {
  return publicTextMatcher.hasMatch(value.normalize("NFKC")) ? "blocked_language" : null;
}

export function isGalleryContributionVisible(value: {
  removedAt: Date | null;
  adminHiddenAt: Date | null;
  contributorSuspendedAt: Date | null;
  selectedAt?: Date | null;
}): boolean {
  if (value.removedAt || value.adminHiddenAt) return false;
  return !value.contributorSuspendedAt || Boolean(value.selectedAt);
}

export function galleryAttribution(value: {
  postAnonymously: boolean;
  publicNickname: string | null;
}): string {
  return value.postAnonymously ? "Anonymous" : value.publicNickname ?? "Anonymous";
}

export function resolveGalleryModelLabel(value: {
  kind: "catalog" | "openrouter" | "custom";
  displayName: string;
  modelId?: string;
}): string {
  if (value.kind === "openrouter") return value.modelId?.trim() || value.displayName;
  if (value.kind === "custom") {
    const modelId = value.modelId?.trim();
    return modelId
      ? `Custom · ${value.displayName} · ${modelId}`
      : `Custom · ${value.displayName}`;
  }
  return value.displayName;
}

export function encodeGalleryCursor(value: GalleryCursor): string {
  return Buffer.from(JSON.stringify([value.score, value.publishedAt.toISOString(), value.id])).toString("base64url");
}

export function decodeGalleryCursor(value: string | null | undefined): GalleryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [score, publishedAt, id] = parsed;
    if (typeof score !== "number" || !Number.isSafeInteger(score) || typeof publishedAt !== "string" || typeof id !== "string") {
      return null;
    }
    const date = new Date(publishedAt);
    return Number.isNaN(date.getTime()) || !id ? null : { score, publishedAt: date, id };
  } catch {
    return null;
  }
}

export function galleryIdentityHmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}
