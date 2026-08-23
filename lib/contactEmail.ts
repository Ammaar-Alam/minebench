import nodemailer, { type Transporter } from "nodemailer";
import {
  SUPPORT_EMAIL,
  getContactCategoryLabel,
  type ContactReceiptStatus,
  type ContactSubmission,
} from "@/lib/contact";

const MINEBENCH_URL = "https://minebench.ai";
const ICON_URL = `${MINEBENCH_URL}/icon.png`;

let transporter: Transporter | null = null;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function messageHtml(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function renderEmailShell({
  preheader,
  eyebrow,
  heading,
  content,
  footer,
}: {
  preheader: string;
  eyebrow: string;
  heading: string;
  content: string;
  footer: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(heading)}</title>
  <style>
    @media only screen and (max-width: 480px) {
      .mb-email-wrap { padding: 28px 12px !important; }
      .mb-email-card { padding: 28px 22px 26px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background:#f6f6f4; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#181818;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; background:#f6f6f4;">
    <tr>
      <td align="center" class="mb-email-wrap" style="padding:48px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:560px;">
          <tr>
            <td style="padding:0 4px 22px 4px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right:10px;">
                    <img src="${ICON_URL}" width="34" height="34" alt="" style="display:block; width:34px; height:34px; border:0; outline:none;">
                  </td>
                  <td valign="middle">
                    <span style="font-size:17px; line-height:22px; font-weight:700; letter-spacing:-0.3px; color:#181818;">MineBench</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="mb-email-card" style="background:#ffffff; border:1px solid #e4e4e1; border-radius:12px; padding:38px 38px 36px 38px;">
              <p style="margin:0 0 12px 0; font-size:12px; line-height:18px; font-weight:700; letter-spacing:0.7px; text-transform:uppercase; color:#168765;">${escapeHtml(eyebrow)}</p>
              <h1 style="margin:0 0 18px 0; font-size:25px; line-height:1.3; font-weight:700; letter-spacing:-0.5px; color:#181818;">${escapeHtml(heading)}</h1>
              ${content}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px 0 4px;">
              <p style="margin:0; font-size:12px; line-height:1.6; color:#8e8e8e;">${escapeHtml(footer)}</p>
              <p style="margin:2px 0 0 0; font-size:12px; line-height:1.6; color:#aaaaaa;">${SUPPORT_EMAIL}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderSubmissionDetails(submission: ContactSubmission, includeEmail: boolean): string {
  const category = getContactCategoryLabel(submission.category);
  const emailRow = includeEmail
    ? `<tr>
        <td style="padding:5px 18px 5px 0; font-size:12px; line-height:18px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#898989;">Email</td>
        <td style="padding:5px 0; font-size:14px; line-height:20px; color:#333333; word-break:break-word;">${submission.email ? escapeHtml(submission.email) : "Not provided"}</td>
      </tr>`
    : "";

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; margin:0 0 26px 0;">
    <tr>
      <td style="padding:5px 18px 5px 0; font-size:12px; line-height:18px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#898989;">Category</td>
      <td style="padding:5px 0; font-size:14px; line-height:20px; color:#333333;">${escapeHtml(category)}</td>
    </tr>
    <tr>
      <td style="padding:5px 18px 5px 0; font-size:12px; line-height:18px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#898989;">Title</td>
      <td style="padding:5px 0; font-size:14px; line-height:20px; color:#333333; word-break:break-word;">${escapeHtml(submission.title)}</td>
    </tr>
    ${emailRow}
  </table>
  <div style="height:1px; line-height:1px; background:#eeeeeb; margin:0 0 22px 0;">&nbsp;</div>
  <p style="margin:0 0 8px 0; font-size:12px; line-height:18px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#898989;">Message</p>
  <p style="margin:0; font-size:15px; line-height:1.7; color:#555555; word-break:break-word;">${messageHtml(submission.message)}</p>`;
}

export function renderContactNotification(submission: ContactSubmission): {
  subject: string;
  text: string;
  html: string;
} {
  const category = getContactCategoryLabel(submission.category);
  const replyButton = submission.email
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
        <tr>
          <td bgcolor="#181818" style="border-radius:8px;">
            <a href="mailto:${escapeHtml(submission.email)}" style="display:inline-block; padding:12px 18px; border-radius:8px; color:#ffffff; font-size:14px; line-height:20px; font-weight:650; text-decoration:none;">Reply</a>
          </td>
        </tr>
      </table>`
    : "";

  return {
    subject: `[MineBench Contact] ${category}: ${submission.title}`,
    text: [
      "New MineBench contact",
      "",
      `Category: ${category}`,
      `Title: ${submission.title}`,
      `Email: ${submission.email ?? "Not provided"}`,
      "",
      "Message",
      submission.message,
    ].join("\n"),
    html: renderEmailShell({
      preheader: `New ${category.toLowerCase()} for MineBench`,
      eyebrow: `Contact · ${category}`,
      heading: submission.title,
      content: `${renderSubmissionDetails(submission, true)}${replyButton}`,
      footer: "MineBench · Contact notification",
    }),
  };
}

export function renderContactReceipt(submission: ContactSubmission): {
  subject: string;
  text: string;
  html: string;
} {
  const category = getContactCategoryLabel(submission.category);
  const intro = `We received your ${category.toLowerCase()}. If we need more information, we'll reply to this address.`;

  return {
    subject: "MineBench received your message",
    text: [
      "Thanks for reaching out",
      "",
      intro,
      "",
      `Category: ${category}`,
      `Title: ${submission.title}`,
      "",
      "Message",
      submission.message,
      "",
      "MineBench",
      SUPPORT_EMAIL,
    ].join("\n"),
    html: renderEmailShell({
      preheader: "MineBench received your message",
      eyebrow: "Message received",
      heading: "Thanks for reaching out",
      content: `<p style="margin:0 0 26px 0; font-size:15px; line-height:1.7; color:#555555;">${escapeHtml(intro)}</p>
        ${renderSubmissionDetails(submission, false)}
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
          <tr>
            <td bgcolor="#181818" style="border-radius:8px;">
              <a href="${MINEBENCH_URL}" style="display:inline-block; padding:12px 18px; border-radius:8px; color:#ffffff; font-size:14px; line-height:20px; font-weight:650; text-decoration:none;">Return to MineBench</a>
            </td>
          </tr>
        </table>`,
      footer: "MineBench · AI spatial reasoning benchmark",
    }),
  };
}

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const password = process.env.CONTACT_SMTP_PASSWORD;
  if (!password) throw new Error("CONTACT_SMTP_PASSWORD is not configured");

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: SUPPORT_EMAIL,
      pass: password,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

export async function deliverContactSubmission(
  submission: ContactSubmission,
): Promise<ContactReceiptStatus> {
  const mailer = getTransporter();
  const notification = renderContactNotification(submission);

  await mailer.sendMail({
    from: { name: "MineBench", address: SUPPORT_EMAIL },
    to: SUPPORT_EMAIL,
    replyTo: submission.email,
    ...notification,
  });

  if (!submission.email) return "not_requested";

  try {
    const receipt = renderContactReceipt(submission);
    await mailer.sendMail({
      from: { name: "MineBench", address: SUPPORT_EMAIL },
      to: submission.email,
      ...receipt,
    });
    return "sent";
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error && typeof error.code === "string"
        ? error.code
        : "unknown";
    console.error("Contact receipt delivery failed", { code });
    return "failed";
  }
}
