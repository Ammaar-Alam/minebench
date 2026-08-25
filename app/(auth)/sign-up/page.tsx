import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AuthDivider,
  AuthMessage,
  AuthShell,
  OAuthButtons,
  PrivacyNote,
} from "@/components/auth/AuthShell";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { getCurrentAccount } from "@/lib/auth/account";
import { createAccount } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Create account",
  robots: { index: false, follow: false },
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const account = await getCurrentAccount().catch(() => null);
  if (account) redirect("/account");
  const params = await searchParams;

  return (
    <AuthShell title="Create account" subtitle="Save your rankings and history.">
      <AuthMessage error={params.error} />
      <OAuthButtons />
      <AuthDivider />
      <form action={createAccount} className="space-y-4">
        <label className="block space-y-2 text-sm font-medium text-fg">
          <span>Name <span className="font-normal text-muted">(optional)</span></span>
          <input className="mb-field h-12 text-base" name="name" autoComplete="name" maxLength={120} />
        </label>
        <label className="block space-y-2 text-sm font-medium text-fg">
          <span>Email</span>
          <input className="mb-field h-12 text-base" name="email" type="email" autoComplete="email" required />
        </label>
        <div className="space-y-2 text-sm font-medium text-fg">
          <label htmlFor="password">Password</label>
          <PasswordInput id="password" name="password" autoComplete="new-password" />
        </div>
        <div className="space-y-2 text-sm font-medium text-fg">
          <label htmlFor="password-confirm">Confirm password</label>
          <PasswordInput id="password-confirm" name="passwordConfirm" autoComplete="new-password" />
        </div>
        <AuthSubmitButton pendingLabel="Creating…">Create account</AuthSubmitButton>
      </form>
      <PrivacyNote />
      <p className="text-sm text-muted">
        Have an account?{" "}
        <Link href="/sign-in" className="font-medium text-fg underline decoration-border underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
