import type { Metadata } from "next";
import { AuthBackLink, AuthMessage, AuthShell } from "@/components/auth/AuthShell";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { requestPasswordReset } from "../actions";

export const metadata: Metadata = {
  title: "Reset password",
  robots: { index: false, follow: false },
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthShell title="Reset password" subtitle="We'll email a reset link.">
      <AuthMessage error={params.error} notice={params.notice} />
      <form action={requestPasswordReset} className="space-y-4">
        <label className="block space-y-2 text-sm font-medium text-fg">
          <span>Email</span>
          <input className="mb-field h-12 text-base" name="email" type="email" autoComplete="email" required />
        </label>
        <AuthSubmitButton pendingLabel="Sending…">Send link</AuthSubmitButton>
      </form>
      <AuthBackLink href="/sign-in">Back to sign in</AuthBackLink>
    </AuthShell>
  );
}
