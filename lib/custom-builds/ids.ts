import { randomBytes } from "node:crypto";

const CUSTOM_BUILD_ID_PREFIX = "cb_";
const CUSTOM_BUILD_ID_RANDOM_BYTES = 18;
const CUSTOM_BUILD_ID_RE = /^cb_[A-Za-z0-9_-]{24}$/;

export function generateCustomBuildPublicId(): string {
  return `${CUSTOM_BUILD_ID_PREFIX}${randomBytes(CUSTOM_BUILD_ID_RANDOM_BYTES).toString("base64url")}`;
}

export function isCustomBuildPublicId(value: unknown): value is string {
  return typeof value === "string" && CUSTOM_BUILD_ID_RE.test(value);
}

export function assertCustomBuildPublicId(value: unknown): string {
  if (!isCustomBuildPublicId(value)) {
    throw new Error("Invalid custom build id");
  }
  return value;
}
