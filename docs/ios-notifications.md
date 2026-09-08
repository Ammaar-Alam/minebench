# Account notifications

Signed-in accounts can receive generation results, hourly Gallery upvote summaries,
and new public contributions to prompts they submitted through email and iOS push.
Generation notifications include work started on the web. Each event produces one
email per account and a separate push for every registered device.
Self-votes and self-contributions do not produce alerts. Upvotes are grouped per
prompt by UTC hour; delivery counts votes still present in that hour.

The native app requests permission after the first successful generation submission.
Account settings control generations, upvotes, and contributions across both
channels. Email has a separate opt-out and works without a registered iOS device.
Foreground banners and sounds are suppressed. Notification taps open the saved
generation or Gallery prompt, after verifying the signed-in recipient. Email links
open the owned build at `/account?generation=...` or the public Gallery prompt.
Signed-out build links retain their destination through sign-in.

## API

All endpoints require the existing account bearer token or session cookie and return
`Cache-Control: private, no-store`.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/account/notifications` | None | `{ settings: { generations, upvotes, contributions, email }, available }` |
| `PUT /api/account/notifications` | Three category Booleans, plus optional `email` Boolean | Same settings envelope |
| `PUT /api/account/notifications/devices` | `{ token, environment }` | `{ registered: true }` |
| `DELETE /api/account/notifications/devices` | `{ token, environment }` | `{ removed: true }` |

Settings default to enabled. Omitting `email` preserves its existing value, including
when a native client changes category preferences. `available` is true only when
`APNS_ENABLED=true`; email delivery is configured independently.
Tokens are even-length hexadecimal strings, at most 512 characters, and are scoped
to `development` or `production`. Registration replaces the account binding for
that token and environment; each account supports up to 20 devices. Removing a
registration requires its current account. Sign-out attempts device removal before
ending the session; cleanup errors do not block sign-out. Account deletion removes
registrations, email and push deliveries, and preferences.

APNs custom fields are `kind`, `id`, and `userId`. Kinds are
`generation_succeeded`, `generation_failed`, `gallery_upvotes`, and
`gallery_contribution`. `id` is the public saved-generation or Gallery identifier;
`userId` is the recipient. Alert text contains no private prompts or contributor
identities.

## Delivery

`NotificationPreference`, `PushDevice`, and `NotificationDelivery` are server-only
tables with RLS enabled and public client grants revoked. Business transactions
enqueue deliveries atomically with their state change. A device/event unique key
deduplicates push; a partial account/event unique index deduplicates email rows,
which have no device. Account foreign keys are retained for both channels.
Producers lock recipient and actor accounts in a consistent order before business
rows, matching account deletion. Serializable account deletion retries a bounded
number of database conflicts before removing the Supabase Auth account.
The generation worker claims batches using `FOR UPDATE SKIP LOCKED` and contacts
APNs or SMTP outside the transaction. Notification polling runs independently of generation
capacity and continues while active generations drain during shutdown.
The worker reuses an HTTP/2 connection per APNs environment and closes connections
after its final notification batch finishes.

Delivery rechecks preferences, device ownership, account deletion, generation
status, and current Gallery visibility. The current account email is loaded only
when delivering and is not duplicated in the outbox. Temporary failures retry each
recipient independently with backoff, up to six attempts. Permanent SMTP rejections
finish immediately. Leases expire after 90 seconds; queued notifications
expire after 24 hours, and delivery records are removed after seven days. APNs
requests allow up to 24 hours for device delivery. Invalid
tokens are removed only if their registration has not changed during the request.
APNs acceptance is not proof of display: iOS controls presentation, and a crash
after acceptance can cause a retry. Event-specific collapse identifiers reduce
duplicate notifications waiting at APNs. Email retries retain one message ID, but
SMTP acceptance followed by a worker crash can also produce a duplicate.

Activity emails reuse `renderMineBenchEmail` and the existing Workspace sender,
`support@minebench.ai`, with both HTML and plain text. Each includes notification
settings. Supabase Auth templates remain responsible for authentication messages.

## Configuration and rollout

1. Enable Push Notifications for `com.ammaaralam.minebench` in Apple Developer
   and refresh the app's provisioning profiles. Debug builds use the development
   APNs environment; Release/TestFlight/App Store builds use production.
   In Certificates, Identifiers & Profiles, create a key with Apple Push Notification
   service enabled. Configure its environment and topic for the signed app, record
   its Key ID, and download the `.p8` file to secure storage. Apple allows one download.
2. Apply the additive Prisma migration to Alpha before deploying the backend.
   Validate the account API and worker there before applying the migration and
   deploying the same change to production.
3. Configure `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_PRIVATE_KEY` on the matching
   generation worker. The private key accepts PEM text or escaped newlines. The
   MineBench signing team is `VM6477A6M8`; the APNs topic is fixed to the app's
   bundle identifier. Keep signing credentials off client and web deployments.
4. Set `APNS_ENABLED=true` on both that worker and its web deployment once signing
   is ready. It defaults to false, which disables enqueue and delivery and reports
   the feature unavailable to the app.

For email, set `EMAIL_NOTIFICATIONS_ENABLED=true` on the web deployment and its
worker. Configure the worker with the existing `CONTACT_SMTP_PASSWORD` and
`MINEBENCH_SITE_URL`. Worker setup identifies `MINEBENCH_ENVIRONMENT` as `alpha` or
`production`. Only production permits arbitrary account recipients; Alpha and local
workers require `NOTIFICATION_EMAIL_TEST_RECIPIENT` and send only to that exact
account email. The same recipient setting can restrict a production canary. Verify
one controlled recipient before enabling general production delivery.

Local Alpha commands use `STAGING_APNS_ENABLED`, `STAGING_APNS_KEY_ID`,
`STAGING_APNS_TEAM_ID`, and `STAGING_APNS_PRIVATE_KEY`. Unset Alpha values are
cleared explicitly, so production signing credentials cannot be inherited. Email
uses `STAGING_EMAIL_NOTIFICATIONS_ENABLED`, `STAGING_CONTACT_SMTP_PASSWORD`, and
`STAGING_NOTIFICATION_EMAIL_TEST_RECIPIENT`; the wrapper maps or clears each value.
Production-to-Alpha refresh excludes all three notification tables' data. APNs
environment follows app signing, so a TestFlight app using Alpha still needs a key
that supports production APNs. Register only controlled test devices in Alpha.

Before release, verify permission grant/denial, foreground suppression, background
and cold-launch taps, web-started generation success/failure, grouped upvotes,
contributions, category toggles, sign-out, account switching, and account deletion
on a physical device. Offline transport and database tests do not establish APNs
delivery or provisioning correctness.
For email, verify the shared template, signed-out build links, hourly summaries,
email opt-out, and channel independence using the controlled recipient.

Apple documents [private key setup](https://developer.apple.com/help/account/keys/create-a-private-key/),
[token-based APNs authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
[notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
and [response handling](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).
