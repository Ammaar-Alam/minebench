"use client";

import { useActionState } from "react";
import {
  updateAccountNotificationSettings,
  type AccountNotificationSettings,
  type NotificationSettingsActionState,
} from "./notification-actions";

const NOTIFICATION_OPTIONS = [
  ["email", "Email updates"],
  ["generations", "Generations"],
  ["upvotes", "Upvotes"],
  ["contributions", "Contributions"],
] as const;

export function NotificationSettings({
  initialSettings,
}: {
  initialSettings: AccountNotificationSettings;
}) {
  const initialState: NotificationSettingsActionState = {
    error: null,
    notice: null,
    draft: initialSettings,
  };
  const [state, action, pending] = useActionState(updateAccountNotificationSettings, initialState);

  return (
    <section id="notifications" className="rounded-md border border-border/80 bg-card/10 p-5 scroll-mt-24" aria-labelledby="notification-settings-title">
      <h2 id="notification-settings-title" className="text-lg font-semibold tracking-tight text-fg">
        Notifications
      </h2>
      <p className="mt-2 text-sm text-muted">Categories apply to email and push.</p>

      <form action={action} className="mt-4 space-y-4">
        <fieldset disabled={pending} className="space-y-2">
          <legend className="sr-only">Notification categories</legend>
          {NOTIFICATION_OPTIONS.map(([name, label]) => (
            <label key={name} className="flex min-h-10 cursor-pointer items-center gap-3 text-sm text-fg">
              <input type="checkbox" name={name} defaultChecked={state.draft[name]} className="h-4 w-4 accent-accent" />
              {label}
            </label>
          ))}
        </fieldset>

        <button type="submit" disabled={pending} className="mb-btn mb-btn-primary h-10 w-full">
          {pending ? "Saving…" : "Save"}
        </button>
        {state.error ? <p role="alert" className="text-sm text-danger">{state.error}</p> : null}
        {state.notice ? <p role="status" className="text-sm text-muted">{state.notice}</p> : null}
      </form>
    </section>
  );
}
