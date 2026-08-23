import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CONTACT_CATEGORIES,
  type ContactReceiptStatus,
  type ContactSubmission,
} from "@/lib/contact";
import { deliverContactSubmission } from "@/lib/contactEmail";

const MAX_BODY_BYTES = 16_384;
const CATEGORY_VALUES = CONTACT_CATEGORIES.map((category) => category.value) as [
  (typeof CONTACT_CATEGORIES)[number]["value"],
  ...(typeof CONTACT_CATEGORIES)[number]["value"][],
];

const contactRequestSchema = z
  .object({
    category: z.enum(CATEGORY_VALUES),
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !/[\r\n]/.test(value)),
    email: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().trim().email().max(254).optional(),
    ),
    message: z.string().trim().min(1).max(5_000),
    website: z.string().max(200).optional().default(""),
  })
  .strict();

type ContactDelivery = (submission: ContactSubmission) => Promise<ContactReceiptStatus>;

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || !error || !("code" in error)) return "unknown";
  return typeof error.code === "string" ? error.code : "unknown";
}

export async function handleContactPost(
  request: Request,
  deliver: ContactDelivery = deliverContactSubmission,
) {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "invalid_submission" }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "invalid_submission" }, 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json({ error: "invalid_submission" }, 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_submission" }, 400);
  }

  const parsed = contactRequestSchema.safeParse(payload);
  if (!parsed.success) return json({ error: "invalid_submission" }, 400);

  const { website, ...submission } = parsed.data;
  if (website) {
    return json({
      ok: true,
      receipt: submission.email ? "sent" : "not_requested",
    });
  }

  try {
    const receipt = await deliver(submission);
    return json({ ok: true, receipt });
  } catch (error) {
    console.error("Contact notification delivery failed", { code: errorCode(error) });
    return json({ error: "delivery_unavailable" }, 503);
  }
}
