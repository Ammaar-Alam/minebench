import { z } from "zod";
import { escapeEmailHtml, renderEmailAction, renderMineBenchEmail } from "@/lib/contactEmail";
import type { PushPayload } from "@/lib/notifications/apns";

export function notificationEmailRecipientAllowed(email: string): boolean {
  if (!z.string().email().safeParse(email).success) return false;
  const testRecipient = process.env.NOTIFICATION_EMAIL_TEST_RECIPIENT?.trim().toLowerCase();
  if (testRecipient) return email.toLowerCase() === testRecipient;
  return process.env.MINEBENCH_ENVIRONMENT === "production";
}

export function renderNotificationEmail(payload: PushPayload) {
  const site = (process.env.MINEBENCH_SITE_URL?.trim() || "https://minebench.ai").replace(/\/+$/, "");
  const generation = payload.kind === "generation_succeeded" || payload.kind === "generation_failed";
  const href = generation
    ? `${site}/account?generation=${encodeURIComponent(payload.id)}`
    : `${site}/gallery/${encodeURIComponent(payload.id)}`;
  const label = generation ? "View build" : "View prompt";
  const settingsHref = `${site}/account#notifications`;
  const { title, body } = payload.aps.alert;
  return {
    subject: `MineBench: ${title}`,
    text: `${title}\n\n${body}\n\n${label}: ${href}\n\nNotification settings: ${settingsHref}`,
    html: renderMineBenchEmail({
      preheader: body,
      eyebrow: generation ? "Your builds" : "Gallery",
      heading: title,
      content: `<p style="margin:0; font-size:15px; line-height:1.7; color:#555555;">${escapeEmailHtml(body)}</p>
        ${renderEmailAction(label, href)}
        <p style="margin:24px 0 0; font-size:13px; line-height:1.6;"><a href="${escapeEmailHtml(settingsHref)}" style="color:#555555;">Manage notifications</a></p>`,
      footer: "MineBench · Account updates",
    }),
  };
}
