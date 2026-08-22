import type { OrganizationRole, StealthExperimentStatus } from "@prisma/client";

const MAX_STEALTH_ARENA_SHARE = 1;
const DEFAULT_STEALTH_ARENA_SHARE = 0.25;

export const ACTIVE_STEALTH_EXPERIMENT_STATUSES: readonly StealthExperimentStatus[] = [
  "ACTIVE",
];

export type StealthVoteGoalPolicy = {
  targetDecisiveVotes: number | null;
  pauseAtGoal: boolean;
};

export function readStealthArenaShare(raw = process.env.STEALTH_ARENA_SHARE): number {
  if (!raw?.trim()) return DEFAULT_STEALTH_ARENA_SHARE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STEALTH_ARENA_SHARE;
  return Math.max(0, Math.min(MAX_STEALTH_ARENA_SHARE, parsed));
}

export function canExportStealthVotes(role: OrganizationRole): boolean {
  return role === "ADMIN" || role === "MEMBER";
}

export function isStealthVoteGoalEnforced(policy: StealthVoteGoalPolicy): boolean {
  return policy.pauseAtGoal && policy.targetDecisiveVotes != null;
}

export function hasReachedStealthVoteGoal(
  policy: StealthVoteGoalPolicy,
  decisiveVotes: number,
): boolean {
  return (
    isStealthVoteGoalEnforced(policy) &&
    decisiveVotes >= Math.max(1, policy.targetDecisiveVotes ?? 0)
  );
}

export function stealthVoteGoalProgress(
  targetDecisiveVotes: number | null,
  decisiveVotes: number,
): number | null {
  if (targetDecisiveVotes == null) return null;
  return Math.min(1, decisiveVotes / Math.max(1, targetDecisiveVotes));
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
