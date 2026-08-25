import Link from "next/link";

const PRIVACY_POLICY_URL =
  "https://github.com/Ammaar-Alam/minebench/blob/master/docs/privacy-policy.md";

const ERROR_MESSAGES: Record<string, string> = {
  credentials: "Incorrect email or password.",
  details: "Check your details and try again.",
  email: "Enter a valid email address.",
  "email-required": "Allow email access, then try again.",
  expired: "This reset link has expired. Request a new one.",
  link: "This confirmation link has expired.",
  oauth: "Couldn't sign in with that provider.",
  password: "Passwords must match and use at least 8 characters.",
  unavailable: "Sign-in is unavailable right now. Try again shortly.",
};

const NOTICE_MESSAGES: Record<string, string> = {
  confirm: "If this is a new account, check your email to confirm it.",
  sent: "If an account exists, a reset link is on its way.",
  "signed-out": "Signed out.",
};

export function AuthMessage({ error, notice }: { error?: string; notice?: string }) {
  const errorMessage = error ? ERROR_MESSAGES[error] : null;
  const noticeMessage = notice ? NOTICE_MESSAGES[notice] : null;
  if (!errorMessage && !noticeMessage) return null;
  return (
    <p
      role={errorMessage ? "alert" : "status"}
      className={`border-y py-3 text-sm text-fg ${
        errorMessage ? "border-danger/35" : "border-accent/35"
      }`}
    >
      {errorMessage ?? noticeMessage}
    </p>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="h-[18px] w-[18px] shrink-0" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.702-1.567 2.684-3.874 2.684-6.614Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.963 10.706A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.168.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.332Z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.463.892 11.43 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z" />
    </svg>
  );
}

function DiscordMark() {
  return (
    <svg aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-[#5865f2]" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.3 18.3 0 0 0-5.487 0 12.6 12.6 0 0 0-.618-1.25.077.077 0 0 0-.078-.037A19.7 19.7 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.319 13.58.099 18.058a.082.082 0 0 0 .031.056c2.053 1.508 4.041 2.423 5.993 3.03a.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 12.3 12.3 0 0 1-1.872-.892.077.077 0 0 1-.007-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.246.198.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029c1.961-.607 3.95-1.522 6.002-3.03a.077.077 0 0 0 .031-.055c.501-5.177-.838-9.674-3.548-13.66a.061.061 0 0 0-.031-.029ZM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.211 0 2.176 1.095 2.157 2.419 0 1.333-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.095 2.157 2.419 0 1.333-.946 2.419-2.157 2.419Z" />
    </svg>
  );
}

function XMark() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993Zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182Z" />
    </svg>
  );
}

const OAUTH_PROVIDERS = [
  { provider: "google", label: "Google", mark: <GoogleMark /> },
  { provider: "discord", label: "Discord", mark: <DiscordMark /> },
  { provider: "x", label: "X", mark: <XMark /> },
];

export function OAuthButtons({ next = "/account" }: { next?: string }) {
  return (
    <div className="grid grid-cols-3 gap-2" aria-label="Social sign-in">
      {OAUTH_PROVIDERS.map(({ provider, label, mark }) => (
        <a
          key={provider}
          href={`/auth/oauth?provider=${provider}&next=${encodeURIComponent(next)}`}
          aria-label={`Continue with ${label}`}
          className="mb-btn mb-btn-ghost h-11 min-w-0 px-2 text-sm font-medium"
        >
          {mark}
          <span>{label}</span>
        </a>
      ))}
    </div>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-[68vh] w-full max-w-lg items-center py-8 sm:py-12">
      <section className="w-full border-y border-border px-1 py-8 sm:px-8 sm:py-10">
        <div className="mx-auto w-full max-w-sm space-y-7">
          <header className="space-y-2">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-fg">{title}</h1>
            {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
          </header>
          {children}
        </div>
      </section>
    </div>
  );
}

export function AuthDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] uppercase tracking-[0.16em] text-muted/70">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function PrivacyNote() {
  return (
    <p className="text-xs text-muted/80">
      <a
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-border underline-offset-2 hover:text-fg"
      >
        Privacy Policy
      </a>
    </p>
  );
}

export function AuthBackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-sm text-muted underline decoration-border underline-offset-4 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {children}
    </Link>
  );
}
