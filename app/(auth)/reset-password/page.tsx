import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthMessage, AuthShell } from "@/components/auth/AuthShell";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { getCurrentAccount } from "@/lib/auth/account";
import { updatePassword } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Choose password",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const account = await getCurrentAccount();
  if (!account) redirect("/forgot-password?error=expired");
  const params = await searchParams;

  return (
    <AuthShell title="Choose password" subtitle="Use at least 8 characters.">
      <AuthMessage error={params.error} />
      <form action={updatePassword} className="space-y-4">
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
