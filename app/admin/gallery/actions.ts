"use server";

import { revalidatePath } from "next/cache";
import { getCurrentAccount } from "@/lib/auth/account";
import {
  hideGalleryCandidate,
  hideGalleryExample,
  selectGalleryCandidate,
  setGalleryPublishingSuspension,
} from "@/lib/gallery/service";
import {
  createVoteBlockFromModerationRecord,
  reverseVoteBlock,
} from "@/lib/voteBlock";

async function adminId() {
  const account = await getCurrentAccount();
  if (!account?.isMineBenchAdmin) throw new Error("MineBench admin access is required");
  return account.id;
}

function refreshGalleryAdmin() {
  revalidatePath("/admin/gallery");
  revalidatePath("/gallery");
}

export async function hideCandidateAction(formData: FormData) {
  await hideGalleryCandidate(await adminId(), String(formData.get("publicId") ?? ""));
  refreshGalleryAdmin();
}

export async function hideExampleAction(formData: FormData) {
  await hideGalleryExample(await adminId(), String(formData.get("exampleId") ?? ""));
  refreshGalleryAdmin();
}

export async function selectCandidateAction(formData: FormData) {
  await selectGalleryCandidate(await adminId(), String(formData.get("publicId") ?? ""));
  refreshGalleryAdmin();
}

export async function suspendAccountAction(formData: FormData) {
  await setGalleryPublishingSuspension(await adminId(), String(formData.get("userId") ?? ""), {
    suspended: true,
    reason: String(formData.get("reason") ?? ""),
  });
  refreshGalleryAdmin();
}

export async function restoreAccountAction(formData: FormData) {
  await setGalleryPublishingSuspension(await adminId(), String(formData.get("userId") ?? ""), {
    suspended: false,
  });
  refreshGalleryAdmin();
}

export async function blockVoteIdentityAction(formData: FormData) {
  await createVoteBlockFromModerationRecord(
    await adminId(),
    String(formData.get("recordId") ?? ""),
    String(formData.get("note") ?? ""),
  );
  refreshGalleryAdmin();
}

export async function reverseVoteBlockAction(formData: FormData) {
  await reverseVoteBlock(await adminId(), String(formData.get("blockId") ?? ""));
  refreshGalleryAdmin();
}
