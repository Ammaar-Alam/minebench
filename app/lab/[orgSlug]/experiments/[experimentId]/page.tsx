import { redirect } from "next/navigation";
import { loadEvaluationWorkspace } from "./data";

export default async function EvaluationPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { workspace } = await loadEvaluationWorkspace(orgSlug, experimentId);
  const basePath = `/lab/${orgSlug}/experiments/${experimentId}`;

  if (workspace.status === "GENERATING") redirect(`${basePath}/builds`);
  if (["ACTIVE", "PAUSED", "CLOSED"].includes(workspace.status)) redirect(`${basePath}/results`);
  redirect(`${basePath}/overview`);
}
