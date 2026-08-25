import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthMessage, AuthShell } from "@/components/auth/AuthShell";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { getCurrentAccountSecurity } from "@/lib/auth/account";
import { requestPasswordSetup, updatePassword } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Change password",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const security = await getCurrentAccountSecurity();
  if (!security) redirect("/forgot-password?error=expired");
  const params = await searchParams;
  const canSetPassword = security.isPasswordRecovery || security.signedInWithPassword;

  if (!canSetPassword) {
    return (
      <AuthShell title="Set password" subtitle="Verify your email first.">
        <AuthMessage error={params.error} />
        <form action={requestPasswordSetup}>
          <AuthSubmitButton pendingLabel="Sending…">Email link</AuthSubmitButton>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Change password"
      subtitle={
        security.isPasswordRecovery
          ? "Use at least 8 characters."
          : "Confirm your current password."
      }
    >
      <AuthMessage error={params.error} />
      <form action={updatePassword} className="space-y-4">
        {security.signedInWithPassword ? (
          <div className="space-y-2 text-sm font-medium text-fg">
            <label htmlFor="current-password">Current password</label>
            <PasswordInput
              id="current-password"
              name="currentPassword"
              autoComplete="current-password"
            />
          </div>
        ) : null}
        <div className="space-y-2 text-sm font-medium text-fg">
          <label htmlFor="new-password">New password</label>
          <PasswordInput id="new-password" name="password" autoComplete="new-password" />
        </div>
        <div className="space-y-2 text-sm font-medium text-fg">
          <label htmlFor="password-confirm">Confirm password</label>
          <PasswordInput id="password-confirm" name="passwordConfirm" autoComplete="new-password" />
        </div>
        <AuthSubmitButton pendingLabel="Saving…">Save password</AuthSubmitButton>
      </form>
    </AuthShell>
  );
}
