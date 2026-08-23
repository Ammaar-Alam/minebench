export const SUPPORT_EMAIL = "support@minebench.ai";

export const CONTACT_CATEGORIES = [
  { value: "bug", label: "Bug report" },
  { value: "feature", label: "Feature request" },
  { value: "feedback", label: "Feedback" },
  { value: "other", label: "Other" },
] as const;

export type ContactCategory = (typeof CONTACT_CATEGORIES)[number]["value"];

export interface ContactSubmission {
  category: ContactCategory;
  title: string;
  email?: string;
  message: string;
}

export type ContactReceiptStatus = "sent" | "failed" | "not_requested";

export function getContactCategoryLabel(category: ContactCategory): string {
  return CONTACT_CATEGORIES.find((item) => item.value === category)?.label ?? "Other";
}
