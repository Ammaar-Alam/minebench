"use server";

import { revalidatePath } from "next/cache";
import { AccountServiceError } from "@/lib/account/service";
import { getCurrentAccount } from "@/lib/auth/account";
import {
  notificationSettingsSchema,
  updateNotificationSettings,
  type NotificationSettings as AccountNotificationSettings,
} from "@/lib/notifications/service";

export type { AccountNotificationSettings };

export type NotificationSettingsActionState = {
  error: string | null;
  notice: string | null;
  draft: AccountNotificationSettings;
};

export async function updateAccountNotificationSettings(
  _state: NotificationSettingsActionState,
  formData: FormData,
): Promise<NotificationSettingsActionState> {
  const draft: AccountNotificationSettings = {
    generations: formData.get("generations") === "on",
    upvotes: formData.get("upvotes") === "on",
    contributions: formData.get("contributions") === "on",
    email: formData.get("email") === "on",
  };
  const account = await getCurrentAccount();
  if (!account) return { error: "Sign in again to continue.", notice: null, draft };

  try {
    await updateNotificationSettings(account.id, notificationSettingsSchema.parse(draft));
    revalidatePath("/account");
    return { error: null, notice: "Notifications saved.", draft };
  } catch (error) {
    return {
      error: error instanceof AccountServiceError ? error.message : "Notifications could not be saved.",
      notice: null,
      draft,
    };
  }
}
