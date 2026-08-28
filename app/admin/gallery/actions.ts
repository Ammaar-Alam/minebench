"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentAccount } from "@/lib/auth/account";
import {
  GalleryServiceError,
  getGalleryAdminPerson,
  hideGalleryExample,
  setGalleryCandidateSelected,
  setGalleryCandidateHidden,
  setGalleryPersonVoteBlocked,
  setGalleryPublishingSuspension,
  setHostedGenerationLimit,
} from "@/lib/gallery/service";

const mutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("candidate_hidden"), publicId: z.string().min(1).max(100), hidden: z.boolean() }),
  z.object({ type: z.literal("example_hidden"), exampleId: z.string().min(1).max(100) }),
  z.object({
    type: z.literal("candidate_selected"),
    publicId: z.string().min(1).max(100),
    selected: z.boolean(),
  }),
  z.object({
    type: z.literal("account_suspended"),
    userId: z.string().uuid(),
    suspended: z.boolean(),
    reason: z.string().trim().max(240).optional(),
  }),
  z.object({ type: z.literal("votes_blocked"), personId: z.string().min(1).max(120), blocked: z.boolean() }),
  z.object({
    type: z.literal("hosted_generation_limit"),
    userId: z.string().uuid(),
    limit: z.number().int().min(0).max(2_147_483_647),
  }),
]);

async function adminId() {
  const account = await getCurrentAccount();
  if (!account?.isMineBenchAdmin) throw new Error("MineBench admin access is required");
  return account.id;
}

function refreshGalleryAdmin() {
  revalidatePath("/admin/gallery");
  revalidatePath("/gallery");
}

function actionError(error: unknown): string {
  if (error instanceof GalleryServiceError) return error.message;
  console.error("Gallery admin action failed", error);
  return "Action failed.";
}

export async function mutateGalleryAdmin(input: unknown) {
  const parsed = mutationSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Check the action." };
  try {
    const actorId = await adminId();
    switch (parsed.data.type) {
      case "candidate_hidden":
        await setGalleryCandidateHidden(actorId, parsed.data.publicId, parsed.data.hidden);
        break;
      case "example_hidden":
        await hideGalleryExample(actorId, parsed.data.exampleId);
        break;
      case "candidate_selected":
        await setGalleryCandidateSelected(actorId, parsed.data.publicId, parsed.data.selected);
        break;
      case "account_suspended":
        await setGalleryPublishingSuspension(actorId, parsed.data.userId, {
          suspended: parsed.data.suspended,
          reason: parsed.data.reason,
        });
        break;
      case "votes_blocked":
        await setGalleryPersonVoteBlocked(actorId, parsed.data.personId, parsed.data.blocked);
        break;
      case "hosted_generation_limit":
        await setHostedGenerationLimit(actorId, parsed.data.userId, parsed.data.limit);
        break;
    }
    refreshGalleryAdmin();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: actionError(error) };
  }
}

export async function loadGalleryAdminPerson(personId: string) {
  try {
    return { ok: true as const, person: await getGalleryAdminPerson(await adminId(), personId) };
  } catch (error) {
    return { ok: false as const, error: actionError(error) };
  }
}
