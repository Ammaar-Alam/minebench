"use client";

import { useState, type FormEvent } from "react";
import {
  CONTACT_CATEGORIES,
  SUPPORT_EMAIL,
  type ContactReceiptStatus,
} from "@/lib/contact";

type FormStatus =
  | { kind: "idle"; message: "" }
  | { kind: "sending"; message: "" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function ContactForm() {
  const [status, setStatus] = useState<FormStatus>({ kind: "idle", message: "" });
  const sending = status.kind === "sending";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();

    setStatus({ kind: "sending", message: "" });

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: data.get("category"),
          title: data.get("title"),
          email: email || undefined,
          message: data.get("message"),
          website: data.get("website"),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        receipt?: ContactReceiptStatus;
      } | null;

      if (!response.ok) {
        setStatus({
          kind: "error",
          message:
            response.status === 429
              ? "Too many messages. Try again later."
              : response.status === 413
                ? "Your message is too long. Shorten it and try again."
                : response.status === 400
                  ? "Please check all fields."
                  : "We couldn’t send your message. Your draft is still here.",
        });
        return;
      }

      form.reset();
      setStatus({
        kind: "success",
        message:
          body?.receipt === "failed"
            ? "Message sent. We couldn’t email a copy."
            : body?.receipt === "sent"
              ? "Message sent. Check your email for a copy."
              : "Message sent.",
      });
    } catch {
      setStatus({
        kind: "error",
        message: "We couldn’t send your message. Your draft is still here.",
      });
    }
  }

  return (
    <form
      aria-busy={sending}
      className="space-y-3.5 pt-3 sm:pt-4"
      onSubmit={onSubmit}
    >
      {/* Row 1: Category & Email */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <label className="block space-y-1.5 text-xs font-medium text-fg sm:text-sm">
          <span>Category</span>
          <select
            className="mb-field h-10 text-sm"
            defaultValue="feedback"
            disabled={sending}
            name="category"
          >
            {CONTACT_CATEGORIES.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-fg sm:text-sm">
          <div className="flex items-center justify-between">
            <span>Email</span>
            <span className="text-[11px] font-normal text-muted">optional (for reply)</span>
          </div>
          <input
            autoComplete="email"
            className="mb-field h-10 text-sm"
            disabled={sending}
            maxLength={254}
            name="email"
            placeholder="you@example.com"
            type="email"
          />
        </label>
      </div>

      {/* Row 2: Subject */}
      <label className="block space-y-1.5 text-xs font-medium text-fg sm:text-sm">
        <span>Subject</span>
        <input
          autoComplete="off"
          className="mb-field h-10 text-sm"
          disabled={sending}
          maxLength={120}
          name="title"
          placeholder="Brief summary of your bug, idea, or question"
          required
        />
      </label>

      {/* Row 3: Message */}
      <label className="block space-y-1.5 text-xs font-medium text-fg sm:text-sm">
        <span>Message</span>
        <textarea
          className="mb-field min-h-24 resize-y py-2 text-sm leading-6 sm:min-h-28"
          disabled={sending}
          maxLength={5_000}
          name="message"
          placeholder="Describe what happened, including model, prompt, or steps to reproduce..."
          required
          rows={3}
        />
      </label>

      {/* Honeypot for spam prevention */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input autoComplete="off" name="website" tabIndex={-1} type="text" />
        </label>
      </div>

      {/* Row 4: Action bar & Email fallback */}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            className="mb-btn mb-btn-primary h-10 min-w-24 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={sending}
            type="submit"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          {status.message && (
            <p
              aria-live="polite"
              className={`text-xs leading-5 sm:text-sm ${
                status.kind === "error"
                  ? "text-danger"
                  : status.kind === "success"
                    ? "text-success"
                    : "text-muted"
              }`}
              role={status.kind === "error" ? "alert" : "status"}
            >
              {status.message}
            </p>
          )}
        </div>

        <p className="text-xs text-muted sm:text-right">
          Prefer email?{" "}
          <a
            className="font-medium text-fg underline decoration-border/70 underline-offset-2 transition-colors hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            href={`mailto:${SUPPORT_EMAIL}?subject=MineBench%20contact`}
          >
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>
    </form>
  );
}
