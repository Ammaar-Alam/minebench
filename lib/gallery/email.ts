import { SUPPORT_EMAIL } from "@/lib/contact";
import {
  escapeEmailHtml,
  renderMineBenchEmail,
  sendMineBenchEmail,
} from "@/lib/contactEmail";

export function renderGalleryNotification(input: {
  heading: string;
  intro: string;
  details?: Record<string, string | null | undefined>;
}) {
  const entries = Object.entries(input.details ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const detailHtml = entries.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; margin-top:22px;">${entries.map(([label, value]) => `<tr><td style="padding:6px 18px 6px 0; vertical-align:top; font-size:12px; line-height:18px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#898989;">${escapeEmailHtml(label)}</td><td style="padding:6px 0; font-size:14px; line-height:20px; color:#333333; word-break:break-word;">${escapeEmailHtml(value)}</td></tr>`).join("")}</table>`
    : "";
  return {
    subject: `MineBench: ${input.heading}`,
    text: [input.heading, "", input.intro, ...entries.map(([label, value]) => `${label}: ${value}`)].join("\n"),
    html: renderMineBenchEmail({
      preheader: input.heading,
      eyebrow: "Gallery",
      heading: input.heading,
      content: `<p style="margin:0; font-size:15px; line-height:1.7; color:#555555;">${escapeEmailHtml(input.intro)}</p>${detailHtml}`,
      footer: "MineBench · Gallery",
    }),
  };
}

export async function sendGalleryAdminNotification(input: Parameters<typeof renderGalleryNotification>[0]) {
  await sendMineBenchEmail({ to: SUPPORT_EMAIL, ...renderGalleryNotification(input) });
}

export async function sendGalleryAccountNotification(
  email: string,
  input: Parameters<typeof renderGalleryNotification>[0],
) {
  await sendMineBenchEmail({ to: email, ...renderGalleryNotification(input) });
}
