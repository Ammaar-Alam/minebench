import { customBuildNoStoreHeaders } from "@/lib/custom-builds/api";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const [created, succeeded, exportsGenerated] = await Promise.all([
    prisma.customBuild.count(),
    prisma.customBuild.count({ where: { status: "succeeded" } }),
    prisma.customBuildArtifact.count({
      where: { kind: { in: ["glb", "stl", "schem"] } },
    }),
  ]);

  return Response.json(
    {
      customBuilds: {
        created,
        succeeded,
        exportsGenerated,
      },
    },
    { headers: customBuildNoStoreHeaders() },
  );
}
