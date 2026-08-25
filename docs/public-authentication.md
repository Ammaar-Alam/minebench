# Public Authentication

MineBench uses Supabase Auth for public accounts and the existing invite-only Lab. Public users
may register with email and password or sign in with Google, Discord, or X. Lab access still
requires an organization invitation; a public account alone grants no Lab membership.

## Application contract

- `/sign-up` creates an email/password identity and requests email confirmation.
- `/sign-in` supports passwords plus Google, Discord, and X.
- `/forgot-password` requests a recovery email; `/reset-password` requires the recovery session.
- `/auth/confirm` exchanges email confirmation and recovery tokens for cookie sessions.
- `/auth/callback` exchanges social OAuth authorization codes for cookie sessions.
- `/account` is private and computes a personal ranking from owned public Arena votes.
- Anonymous Arena voting remains available. On sign-in, unowned public votes from the current
  `mb_session` are claimed once and the cookie is rotated.
- Private evaluation votes are never attached to public accounts and never enter personal or
  public rankings.

## Identity and admin roles

Supabase Auth owns identity. MineBench keys its `User` row to the Supabase user UUID, while
`isMineBenchAdmin` and organization memberships remain authorization data on that same row. A
public account never grants either role.

Supabase automatically links OAuth identities that return the same verified email to one Auth
user. Signing in with Google after using the same email for password or Lab access therefore
returns the existing UUID; MineBench refreshes profile fields without changing admin status or
memberships. Administrators use the same account for public rankings and protected tools.

An OAuth user who wants password sign-in should sign in with OAuth and use **Change password** on
the account page. Registering the same email again does not send a confirmation email, by design,
so registration responses must remain generic. See [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).

Do not insert local-only admin rows. Admin provisioning must first resolve the Supabase Auth user
and store that UUID; MineBench will reject a conflicting email rather than transfer privileges to
a different identity.

## Supabase URL configuration

In Authentication → URL Configuration:

1. Set the production Site URL to `https://minebench.ai`.
2. Add these production redirect URLs:
   - `https://minebench.ai/auth/callback`
   - `https://minebench.ai/auth/confirm`
   - `https://minebench.ai/lab/auth/confirm`
3. Add the same three paths for the current Alpha deployment origin in the Alpha Supabase branch.
4. For local development, allow the three paths on `http://localhost:3000`.

Use exact production paths. Preview wildcards are appropriate only for protected preview
deployments that intentionally share an Auth project.

## Email and password

In Authentication → Sign In / Providers → Email:

- enable email/password sign-in;
- require email confirmation; and
- keep secure password protection and leaked-password checks enabled when available on the plan.

Configure custom SMTP in Supabase with the existing `support@minebench.ai` Google Workspace
mailbox. Supabase, not the Next.js application, sends confirmation and recovery mail. The default
mailer is rate-limited and is not a production delivery path.

The confirmation template can use this link:

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">
  Confirm email address
</a>
```

The recovery template can use this link:

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">
  Reset password
</a>
```

The email-change template can use this link:

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email_change">
  Confirm email address
</a>
```

The reauthentication template must display `{{ .Token }}` as the verification code.
Keep the Lab magic-link template on `{{ .ConfirmationURL }}` because its redirect already carries
the invite-only Lab destination. Enable password-changed, email-changed, identity-linked, and
identity-unlinked security notifications in Authentication → Email Templates.

## Social providers

Each provider application redirects to the Supabase callback URL displayed in Authentication →
Sign In / Providers. The provider callback is the Supabase `/auth/v1/callback` URL, not the
MineBench `/auth/callback` route.

### Google

Create a Web OAuth client in Google Auth Platform. Add `https://minebench.ai` as an authorized
JavaScript origin, copy the Supabase Google callback URL into Authorized redirect URIs, and enable
the `openid`, email, and profile scopes. Store the client ID and client secret in the Supabase
Google provider panel.

### Discord

Create a Discord application, add the Supabase Discord callback URL under OAuth2 Redirects, and
store its client ID and client secret in the Supabase Discord provider panel.

### X

Use the Supabase **X / Twitter (OAuth 2.0)** provider. In the X application, select a Web App,
enable **Request email from users**, add the Supabase X callback URL, and set the MineBench website
and privacy-policy URLs. Store the OAuth 2.0 client ID and secret in the Supabase provider panel.
The application intentionally uses the current `x` provider key rather than legacy OAuth 1.0a.

## Vote logs and abuse response

Every stored or duplicate Arena vote writes one structured `arena_vote` runtime log. Fields
include outcome, opaque vote ID, choice, public/private scope, authentication and ownership flags,
Vercel request ID, trusted client IP, user agent, and Vercel's IP-derived country, region, city,
postal code, latitude, and longitude. Geo fields are approximate network-location data, not GPS.

Use Vercel Logs or a restricted Log Drain to investigate a vote ID or IP. Repeated abuse can be
rate-limited or temporarily blocked through Vercel Firewall. Do not copy IP-linked logs into
product analytics, public datasets, or long-lived research exports.

## Release order

1. Refresh Alpha from production.
2. Apply `20260825120000_public_vote_ownership` to Alpha before deploying the new code.
3. Configure Alpha URL, SMTP, and provider settings.
4. Exercise anonymous voting, each sign-in method, confirmation, recovery, vote claiming, sign-out,
   and personal rankings in Alpha.
5. Confirm private votes remain unowned and absent from account rankings.
6. Apply the additive migration to production, deploy the same tested commit, then enable the
   production Auth provider applications.
