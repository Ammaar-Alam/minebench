import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthMessage, AuthShell } from "@/components/auth/AuthShell";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
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
        <label className="block space-y-2 text-sm font-medium text-fg">
          <span>New password</span>
          <input className="mb-field h-12 text-base" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
        </label>
        <label className="block space-y-2 text-sm font-medium text-fg">
          <span>Confirm password</span>
          <input className="mb-field h-12 text-base" name="passwordConfirm" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
        </label>
        <AuthSubmitButton pendingLabel="Saving…">Save password</AuthSubmitButton>
      </form>
    </AuthShell>
  );
}
