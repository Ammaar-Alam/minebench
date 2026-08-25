import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AuthDivider,
  AuthMessage,
  AuthShell,
  OAuthButtons,
} from "@/components/auth/AuthShell";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { getCurrentAccount } from "@/lib/auth/account";
import { safeNextPath } from "@/lib/auth/redirects";
import { signInWithPassword } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next, "/account");
  const account = await getCurrentAccount().catch(() => null);
  if (account) redirect(next);

  return (
    <AuthShell title="Sign in" subtitle="View your rankings and history.">
      <AuthMessage error={params.error} notice={params.notice} />
      <OAuthButtons next={next} />
      <AuthDivider />
      <form action={signInWithPassword} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <label className="block space-y-2 text-sm font-medium text-fg">
          <span>Email</span>
          <input
            className="mb-field h-12 text-base"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </label>
        <div className="space-y-2 text-sm font-medium text-fg">
          <span className="flex items-center justify-between gap-3">
            <label htmlFor="password">Password</label>
            <Link href="/forgot-password" className="font-normal text-muted hover:text-fg">
              Forgot password?
            </Link>
          </span>
          <PasswordInput id="password" name="password" autoComplete="current-password" />
        </div>
        <AuthSubmitButton pendingLabel="Signing in…">Sign in</AuthSubmitButton>
      </form>
      <p className="text-sm text-muted">
        New to MineBench?{" "}
        <Link href="/sign-up" className="font-medium text-fg underline decoration-border underline-offset-4">
          Create account
        </Link>
      </p>
    </AuthShell>
  );
}
