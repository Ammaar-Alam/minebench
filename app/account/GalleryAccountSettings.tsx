"use client";

import { useActionState } from "react";
import {
  appealGallerySuspension,
  type GalleryAccountActionState,
  updatePublicNickname,
} from "./gallery-actions";

const EMPTY_STATE: GalleryAccountActionState = { error: null, notice: null, draft: "" };

export function GalleryAccountSettings({
  publicNickname,
  suspendedAt,
  suspensionReason,
}: {
  publicNickname: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
}) {
  const [nickname, nicknameAction, nicknamePending] = useActionState(updatePublicNickname, {
    ...EMPTY_STATE,
    draft: publicNickname ?? "",
  });
  const [appeal, appealAction, appealPending] = useActionState(appealGallerySuspension, EMPTY_STATE);

  return (
    <section className="rounded-md border border-border/80 bg-card/10 p-5" aria-labelledby="gallery-account-title">
      <p className="mb-eyebrow">Gallery</p>
      <h2 id="gallery-account-title" className="mt-2 text-lg font-semibold tracking-tight text-fg">
        Public identity
      </h2>
      <p className="mt-2 text-sm text-muted">Used only when you publish by name.</p>
      {suspendedAt ? (
        <div className="mt-5 rounded border border-danger/40 bg-danger/5 p-3">
          <p className="font-semibold text-fg">Account suspended</p>
          <p className="mt-1 text-sm text-muted">
            Since {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(suspendedAt))}.
            {suspensionReason ? ` ${suspensionReason}` : ""}
          </p>
        </div>
      ) : null}

      <form action={nicknameAction} className="mt-5 space-y-2">
        <label htmlFor="publicNickname" className="text-sm font-medium text-fg">Public name</label>
        <input
          id="publicNickname"
          name="publicNickname"
          maxLength={40}
          defaultValue={nickname.draft}
          className="mb-field h-10 w-full"
          autoComplete="nickname"
        />
        <button type="submit" disabled={nicknamePending} className="mb-btn mb-btn-primary h-10 w-full">
          {nicknamePending ? "Saving…" : "Save"}
        </button>
        {nickname.error ? <p role="alert" className="text-sm text-danger">{nickname.error}</p> : null}
        {nickname.notice ? <p role="status" className="text-sm text-muted">{nickname.notice}</p> : null}
      </form>

      {suspendedAt ? (
        <form action={appealAction} className="mt-5 space-y-2 border-t border-border pt-5">
          <label htmlFor="explanation" className="text-sm font-medium text-fg">Appeal</label>
          <textarea
            id="explanation"
            name="explanation"
            required
            maxLength={2000}
            defaultValue={appeal.draft}
            rows={4}
            className="mb-field w-full resize-y py-2"
          />
          <button type="submit" disabled={appealPending} className="mb-btn h-10 w-full">
            {appealPending ? "Sending…" : "Send"}
          </button>
          {appeal.error ? <p role="alert" className="text-sm text-danger">{appeal.error}</p> : null}
          {appeal.notice ? <p role="status" className="text-sm text-muted">{appeal.notice}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
