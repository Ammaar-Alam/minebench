"use server";

import type { OrganizationRole } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { start as startWorkflow } from "workflow/api";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import type { StealthEndpointProtocol } from "@/lib/stealth/credentials";
import {
  activateStealthEvaluation,
  closeStealthEvaluation,
  completeUploadedStealthCohortFromStorage,
  configureStealthEndpoint,
  createStealthEvaluation,
  deleteUnusedDraftEvaluation,
  disableStealthEndpoint,
  inviteOrganizationMember,
  pauseStealthEvaluation,
  removeOrganizationMember,
  resumeStealthEvaluation,
  sanitizeOperationalError,
  updateOrganizationMember,
  updateStealthEvaluation,
  type StealthActor,
} from "@/lib/stealth/service";
import { startStealthGeneration } from "@/lib/stealth/generationRun";
import { generateStealthCohortWorkflow } from "@/workflows/stealth-generation";

type OrganizationActionContext = {
  actor: StealthActor;
  organizationId: string;
};

async function organizationContext(orgSlug: string): Promise<OrganizationActionContext> {
  const context = await getLabOrganizationContext(orgSlug);
  if (!context) throw new Error("Sign in again");
  return {
    actor: { organizationUser: { userId: context.user.id } },
    organizationId: context.membership.organization.id,
  };
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === "on" || formData.get(name) === "true";
}

function optionalPositiveInt(formData: FormData, name: string, max: number): number | null {
  const value = text(formData, name);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be from 1 to ${max}`);
  }
  return parsed;
}

function requiredPositiveInt(
  formData: FormData,
  name: string,
  fallback: number,
  max: number,
): number {
  return optionalPositiveInt(formData, name, max) ?? fallback;
}

function organizationRole(formData: FormData): OrganizationRole {
  const role = text(formData, "role").toUpperCase();
  if (role !== "ADMIN" && role !== "MEMBER") throw new Error("Invalid role");
  return role;
}

function endpointProtocol(formData: FormData): StealthEndpointProtocol {
  const protocol = text(formData, "protocol") || "openai-compatible";
  if (
    protocol !== "openai-compatible" &&
    protocol !== "openrouter" &&
    protocol !== "anthropic" &&
    protocol !== "gemini"
  ) {
    throw new Error("Invalid endpoint protocol");
  }
  return protocol;
}

function revalidateEvaluation(orgSlug: string, experimentId?: string): void {
  revalidatePath("/lab");
  revalidatePath(`/lab/${orgSlug}`);
  if (experimentId) revalidatePath(`/lab/${orgSlug}/experiments/${experimentId}`, "layout");
}

export async function createEvaluationAction(orgSlug: string, formData: FormData) {
  const context = await organizationContext(orgSlug);
  const targetDecisiveVotes = optionalPositiveInt(formData, "targetDecisiveVotes", 1_000_000);
  const evaluation = await createStealthEvaluation(context.actor, context.organizationId, {
    name: text(formData, "name"),
    targetDecisiveVotes,
    pauseAtGoal: targetDecisiveVotes == null ? true : checked(formData, "pauseAtGoal"),
  });
  revalidateEvaluation(orgSlug, evaluation.id);
  redirect(`/lab/${orgSlug}/experiments/${evaluation.id}`);
}

export async function inviteMemberAction(orgSlug: string, formData: FormData) {
  const context = await organizationContext(orgSlug);
  await inviteOrganizationMember(context.actor, context.organizationId, {
    email: text(formData, "email"),
    role: organizationRole(formData),
  });
  revalidateEvaluation(orgSlug);
}

export async function updateMemberRoleAction(orgSlug: string, formData: FormData) {
  const context = await organizationContext(orgSlug);
  await updateOrganizationMember(context.actor, context.organizationId, {
    email: text(formData, "email"),
    role: organizationRole(formData),
  });
  revalidateEvaluation(orgSlug);
}

export async function removeMemberAction(orgSlug: string, formData: FormData) {
  const context = await organizationContext(orgSlug);
  await removeOrganizationMember(context.actor, context.organizationId, {
    email: text(formData, "email"),
  });
  revalidateEvaluation(orgSlug);
}

export async function configureEndpointAction(
  orgSlug: string,
  experimentId: string,
  formData: FormData,
) {
  const context = await organizationContext(orgSlug);
  await configureStealthEndpoint(context.actor, context.organizationId, experimentId, {
    variantId: text(formData, "variantId") || undefined,
    codename: text(formData, "codename"),
    config: {
      protocol: endpointProtocol(formData),
      endpointUrl: text(formData, "endpointUrl"),
      apiKey: text(formData, "apiKey"),
      modelId: text(formData, "modelId"),
      maxOutputTokens:
        optionalPositiveInt(formData, "maxOutputTokens", 1_000_000) ?? undefined,
      requireStructuredOutput: checked(formData, "requireStructuredOutput"),
      enableTools: checked(formData, "enableTools"),
      reasoning: text(formData, "reasoning") || undefined,
    },
  });
  revalidateEvaluation(orgSlug, experimentId);
}

export async function uploadCohortAction(
  orgSlug: string,
  experimentId: string,
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const context = await organizationContext(orgSlug);
    await completeUploadedStealthCohortFromStorage(
      context.actor,
      context.organizationId,
      experimentId,
      {
        variantId: text(formData, "variantId") || undefined,
        codename: text(formData, "codename"),
        bucket: text(formData, "cohortUploadBucket"),
        path: text(formData, "cohortUploadPath"),
      },
    );
    revalidateEvaluation(orgSlug, experimentId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: sanitizeOperationalError(error) };
  }
}

export async function startGenerationAction(
  orgSlug: string,
  experimentId: string,
  variantId: string,
  formData: FormData,
) {
  const context = await organizationContext(orgSlug);
  await startStealthGeneration(
    context.actor,
    context.organizationId,
    variantId,
    {
      maxAttempts: requiredPositiveInt(formData, "maxAttempts", 3, 10),
      concurrency: 1,
    },
    async (runId) => (await startWorkflow(generateStealthCohortWorkflow, [runId])).runId,
  );
  revalidateEvaluation(orgSlug, experimentId);
}

export async function updateEvaluationAction(
  orgSlug: string,
  experimentId: string,
  formData: FormData,
) {
  const context = await organizationContext(orgSlug);
  const targetDecisiveVotes = optionalPositiveInt(formData, "targetDecisiveVotes", 1_000_000);
  await updateStealthEvaluation(context.actor, context.organizationId, experimentId, {
    name: text(formData, "name") || undefined,
    targetDecisiveVotes,
    pauseAtGoal: targetDecisiveVotes == null ? true : checked(formData, "pauseAtGoal"),
  });
  revalidateEvaluation(orgSlug, experimentId);
}

export async function activateEvaluationAction(orgSlug: string, experimentId: string) {
  const context = await organizationContext(orgSlug);
  await activateStealthEvaluation(context.actor, context.organizationId, experimentId);
  revalidateEvaluation(orgSlug, experimentId);
}

export async function pauseEvaluationAction(orgSlug: string, experimentId: string) {
  const context = await organizationContext(orgSlug);
  await pauseStealthEvaluation(context.actor, context.organizationId, experimentId);
  revalidateEvaluation(orgSlug, experimentId);
}

export async function resumeEvaluationAction(orgSlug: string, experimentId: string) {
  const context = await organizationContext(orgSlug);
  await resumeStealthEvaluation(context.actor, context.organizationId, experimentId);
  revalidateEvaluation(orgSlug, experimentId);
}

export async function closeEvaluationAction(orgSlug: string, experimentId: string) {
  const context = await organizationContext(orgSlug);
  await closeStealthEvaluation(context.actor, context.organizationId, experimentId);
  revalidateEvaluation(orgSlug, experimentId);
}

export async function disableEndpointAction(
  orgSlug: string,
  experimentId: string,
  variantId: string,
) {
  const context = await organizationContext(orgSlug);
  await disableStealthEndpoint(context.actor, context.organizationId, variantId);
  revalidateEvaluation(orgSlug, experimentId);
}

export async function deleteDraftEvaluationAction(orgSlug: string, experimentId: string) {
  const context = await organizationContext(orgSlug);
  await deleteUnusedDraftEvaluation(context.actor, context.organizationId, experimentId);
  revalidateEvaluation(orgSlug);
  redirect(`/lab/${orgSlug}`);
}
