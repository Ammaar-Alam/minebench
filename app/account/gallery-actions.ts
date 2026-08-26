"use server";

import { revalidatePath } from "next/cache";
import { getCurrentAccount } from "@/lib/auth/account";
import {
  GalleryServiceError,
  submitGalleryAppeal,
  updateGalleryNickname,
} from "@/lib/gallery/service";

export type GalleryAccountActionState = {
  error: string | null;
  notice: string | null;
  draft: string;
};

export async function updatePublicNickname(
  _state: GalleryAccountActionState,
  formData: FormData,
): Promise<GalleryAccountActionState> {
  const draft = String(formData.get("publicNickname") ?? "");
  const account = await getCurrentAccount();
  if (!account) return { error: "Sign in again to continue.", notice: null, draft };
  try {
    const updated = await updateGalleryNickname(account.id, draft);
    revalidatePath("/account");
    revalidatePath("/gallery");
    return {
      error: null,
      notice: updated.publicNickname ? "Public name saved." : "Public name removed.",
      draft: updated.publicNickname ?? "",
    };
  } catch (error) {
    return {
      error: error instanceof GalleryServiceError ? error.message : "Public name could not be saved.",
      notice: null,
      draft,
    };
  }
}

export async function appealGallerySuspension(
  _state: GalleryAccountActionState,
  formData: FormData,
): Promise<GalleryAccountActionState> {
  const draft = String(formData.get("explanation") ?? "");
  const account = await getCurrentAccount();
  if (!account) return { error: "Sign in again to continue.", notice: null, draft };
  try {
    await submitGalleryAppeal(account.id, draft);
    return { error: null, notice: "Appeal sent.", draft: "" };
  } catch (error) {
    return {
      error: error instanceof GalleryServiceError ? error.message : "Appeal could not be sent.",
      notice: null,
      draft,
    };
  }
}
