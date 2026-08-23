import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { getStealthExperimentReport } from "@/lib/stealth/report";
import { getStealthEvaluationWorkspace } from "@/lib/stealth/service";

export const loadEvaluationWorkspace = cache(async (orgSlug: string, experimentId: string) => {
  const context = await getLabOrganizationContext(orgSlug).catch(() => null);
  if (!context) redirect("/lab/sign-in");

  const workspace = await getStealthEvaluationWorkspace(
    { organizationUser: { userId: context.user.id } },
    context.membership.organization.id,
    experimentId,
  );
  if (!workspace) notFound();
  return { context, workspace };
});

export const loadEvaluationReport = cache(async (orgSlug: string, experimentId: string) => {
  const { context, workspace } = await loadEvaluationWorkspace(orgSlug, experimentId);
  const report = await getStealthExperimentReport(experimentId);
  if (!report || report.organization.id !== context.membership.organization.id) notFound();
  return { context, workspace, report };
});
