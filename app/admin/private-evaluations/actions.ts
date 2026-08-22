"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLabIdentity } from "@/lib/stealth/auth";
import {
  activateStealthEvaluation,
  closeStealthEvaluation,
  createStealthEvaluation,
  disableStealthEndpoint,
  pauseStealthEvaluation,
  provisionStealthOrganization,
  resumeStealthEvaluation,
} from "@/lib/stealth/service";

async function requireMineBenchAdmin() {
  const identity = await getLabIdentity();
  if (!identity?.user.isMineBenchAdmin) throw new Error("MineBench admin access is required");
  return { minebenchAdmin: true } as const;
}

export async function activateAdminEvaluationAction(
  organizationId: string,
  experimentId: string,
) {
  await activateStealthEvaluation(await requireMineBenchAdmin(), organizationId, experimentId);
  await refresh(experimentId);
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export async function provisionOrganizationAction(formData: FormData) {
  const actor = await requireMineBenchAdmin();
  await provisionStealthOrganization(actor, {
    name: text(formData, "name"),
    slug: text(formData, "slug"),
    initialAdminEmail: text(formData, "initialAdminEmail"),
  });
  revalidatePath("/admin/private-evaluations");
}

export async function createAdminEvaluationAction(organizationId: string, formData: FormData) {
  const actor = await requireMineBenchAdmin();
  const evaluation = await createStealthEvaluation(actor, organizationId, {
    name: text(formData, "name"),
  });
  revalidatePath("/admin/private-evaluations");
  redirect(
    `/admin/private-evaluations/${evaluation.id}?organizationId=${encodeURIComponent(organizationId)}`,
  );
}

async function refresh(experimentId: string): Promise<void> {
  revalidatePath("/admin/private-evaluations");
  revalidatePath(`/admin/private-evaluations/${experimentId}`);
}

export async function pauseAdminEvaluationAction(
  organizationId: string,
  experimentId: string,
) {
  await pauseStealthEvaluation(await requireMineBenchAdmin(), organizationId, experimentId);
  await refresh(experimentId);
}

export async function resumeAdminEvaluationAction(
  organizationId: string,
  experimentId: string,
) {
  await resumeStealthEvaluation(await requireMineBenchAdmin(), organizationId, experimentId);
  await refresh(experimentId);
}

export async function closeAdminEvaluationAction(
  organizationId: string,
  experimentId: string,
) {
  await closeStealthEvaluation(await requireMineBenchAdmin(), organizationId, experimentId);
  await refresh(experimentId);
}

export async function disableAdminEndpointAction(
  organizationId: string,
  experimentId: string,
  variantId: string,
) {
  await disableStealthEndpoint(await requireMineBenchAdmin(), organizationId, variantId);
  await refresh(experimentId);
}
