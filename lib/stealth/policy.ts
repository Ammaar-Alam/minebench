import type { OrganizationRole, StealthExperimentStatus } from "@prisma/client";

const MAX_STEALTH_ARENA_SHARE = 1;
const DEFAULT_STEALTH_ARENA_SHARE = 0.25;

export const ACTIVE_STEALTH_EXPERIMENT_STATUSES: readonly StealthExperimentStatus[] = [
  "ACTIVE",
  "STABLE",
];

export function readStealthArenaShare(raw = process.env.STEALTH_ARENA_SHARE): number {
  if (!raw?.trim()) return DEFAULT_STEALTH_ARENA_SHARE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STEALTH_ARENA_SHARE;
  return Math.max(0, Math.min(MAX_STEALTH_ARENA_SHARE, parsed));
}

export function canExportStealthVotes(role: OrganizationRole): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "ANALYST";
}

export function normalizeStealthSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function opaqueStealthModelKey(experimentId: string, variantId: string): string {
  return `stealth/${experimentId}/${variantId}`;
}
