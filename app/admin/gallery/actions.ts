"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { publishAdminGeneration } from "@/lib/generations/service";
import { getCurrentAccount } from "@/lib/auth/account";
import { getArenaVotePage, getArenaVoteReview, setArenaVoteSessionBlocked } from "@/lib/arena/voteReview";
import { removePublicArenaVotes } from "@/lib/arena/voteModeration";
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
  z.object({ type: z.literal("generation_published"), publicId: z.string().min(1).max(100) }),
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
      case "generation_published":
        await publishAdminGeneration(actorId, parsed.data.publicId);
        break;
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

const sessionSchema = z.string().min(1).max(191);
const voteCursorSchema = z.object({ id: z.string().min(1).max(191), createdAt: z.string().datetime() }).optional();

export async function loadArenaVoteReview() {
  try {
    return { ok: true as const, data: await getArenaVoteReview(await adminId()) };
  } catch (error) {
    return { ok: false as const, error: actionError(error) };
  }
}

export async function loadArenaVotePage(sessionId: string, cursor?: { id: string; createdAt: string }) {
  const parsed = z.object({ sessionId: sessionSchema, cursor: voteCursorSchema }).safeParse({ sessionId, cursor });
  if (!parsed.success) return { ok: false as const, error: "Invalid vote selection." };
  try {
    return { ok: true as const, data: await getArenaVotePage(await adminId(), parsed.data.sessionId, parsed.data.cursor) };
  } catch (error) {
    return { ok: false as const, error: actionError(error) };
  }
}

export async function removeArenaReviewVotes(sessionId: string, voteIds: string[]) {
  const parsed = z.object({ sessionId: sessionSchema, voteIds: z.array(z.string().min(1).max(191)).min(1).max(1000) }).safeParse({ sessionId, voteIds });
  if (!parsed.success) return { ok: false as const, error: "Select up to 1,000 votes." };
  try {
    const result = await removePublicArenaVotes(await adminId(), parsed.data.sessionId, parsed.data.voteIds);
    refreshGalleryAdmin();
    revalidatePath("/leaderboard");
    return { ok: true as const, ...result };
  } catch (error) {
    return { ok: false as const, error: actionError(error) };
  }
}

export async function blockArenaReviewSession(sessionId: string, blocked: boolean) {
  const parsed = z.object({ sessionId: sessionSchema, blocked: z.boolean() }).safeParse({ sessionId, blocked });
  if (!parsed.success) return { ok: false as const, error: "Invalid vote restriction." };
  try {
    await setArenaVoteSessionBlocked(await adminId(), parsed.data.sessionId, parsed.data.blocked);
    refreshGalleryAdmin();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: actionError(error) };
  }
}
