import type { Prisma } from "@prisma/client";

export function readableStealthEvaluationWhere(
  now = new Date(),
): Prisma.StealthExperimentWhereInput {
  return {
    OR: [{ retentionDeleteAt: null }, { retentionDeleteAt: { gt: now } }],
  };
}
