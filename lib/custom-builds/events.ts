import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type PrismaTx = Prisma.TransactionClient;

export type CustomBuildEventData = Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;

export async function appendCustomBuildEvent(
  customBuildId: string,
  type: string,
  data?: CustomBuildEventData,
  client: PrismaClient = prisma,
) {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "CustomBuild"
      WHERE id = ${customBuildId}
      FOR UPDATE
    `;
    const latest = await tx.customBuildEvent.aggregate({
      where: { customBuildId },
      _max: { seq: true },
    });
    return tx.customBuildEvent.create({
      data: {
        customBuildId,
        seq: (latest._max.seq ?? 0) + 1,
        type,
        data: data ?? Prisma.JsonNull,
      },
    });
  });
}

export async function listCustomBuildEventsAfter(
  customBuildId: string,
  afterSeq: number,
  client: PrismaClient | PrismaTx = prisma,
) {
  return client.customBuildEvent.findMany({
    where: {
      customBuildId,
      seq: { gt: Math.max(0, Math.floor(afterSeq)) },
    },
    orderBy: { seq: "asc" },
  });
}
