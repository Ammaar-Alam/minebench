# iOS notifications

Signed-in accounts can receive generation results, hourly Gallery upvote summaries,
and new public contributions to prompts they submitted. Generation notifications
include work started on the web and reach every device registered to the account.
Self-votes and self-contributions do not produce alerts. Upvotes are grouped per
prompt by UTC hour; delivery counts votes still present in that hour.

The native app requests permission after the first successful generation submission.
Account settings control generations, upvotes, and contributions separately.
Foreground banners and sounds are suppressed. Notification taps open the saved
generation or Gallery prompt, after verifying the signed-in recipient.

## API

All endpoints require the existing account bearer token or session cookie and return
`Cache-Control: private, no-store`.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/account/notifications` | None | `{ settings: { generations, upvotes, contributions }, available }` |
| `PUT /api/account/notifications` | The three Boolean settings, all required | Same settings envelope |
| `PUT /api/account/notifications/devices` | `{ token, environment }` | `{ registered: true }` |
| `DELETE /api/account/notifications/devices` | `{ token, environment }` | `{ removed: true }` |

Settings default to enabled. `available` is true only when `APNS_ENABLED=true`.
Tokens are even-length hexadecimal strings, at most 512 characters, and are scoped
to `development` or `production`. Registration replaces the account binding for
that token and environment; each account supports up to 20 devices. Removing a
registration requires its current account. Sign-out removes the device before
ending the session, and account deletion removes registrations and preferences.

APNs custom fields are `kind`, `id`, and `userId`. Kinds are
`generation_succeeded`, `generation_failed`, `gallery_upvotes`, and
`gallery_contribution`. `id` is the public saved-generation or Gallery identifier;
`userId` is the recipient. Alert text contains no private prompts or contributor
identities.

## Delivery

`NotificationPreference`, `PushDevice`, and `PushDelivery` are server-only tables
with RLS enabled and public client grants revoked. Business transactions enqueue
one delivery per registered device. A device/event unique key deduplicates enqueue.
The generation worker claims batches using `FOR UPDATE SKIP LOCKED` and contacts
APNs outside the transaction. Notification polling runs independently of generation
capacity and continues while active generations drain during shutdown.

Delivery rechecks preferences, device ownership, account deletion, generation
status, and current Gallery visibility. Individual devices retry temporary failures
with backoff, up to six attempts. Leases expire after 90 seconds; queued notifications
expire after 24 hours, and delivery records are removed after seven days. APNs
requests allow up to 24 hours for device delivery. Invalid
tokens are removed only if their registration has not changed during the request.
APNs acceptance is not proof of display: iOS controls presentation, and a crash
after acceptance can cause a retry. Event-specific collapse identifiers reduce
duplicate notifications waiting at APNs.

## Configuration and rollout

1. Enable Push Notifications for `com.ammaaralam.minebench` in Apple Developer
   and refresh the app's provisioning profiles. Debug builds use the development
   APNs environment; Release/TestFlight/App Store builds use production.
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

Local Alpha commands use `STAGING_APNS_ENABLED`, `STAGING_APNS_KEY_ID`,
`STAGING_APNS_TEAM_ID`, and `STAGING_APNS_PRIVATE_KEY`. Unset Alpha values are
cleared explicitly, so production signing credentials cannot be inherited.
Production-to-Alpha refresh excludes all three notification tables' data.
Register only controlled test devices in Alpha.

Before release, verify permission grant/denial, foreground suppression, background
and cold-launch taps, web-started generation success/failure, grouped upvotes,
contributions, category toggles, sign-out, account switching, and account deletion
on a physical device. Offline transport and database tests do not establish APNs
delivery or provisioning correctness.

Apple documents [token-based APNs authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
[notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
and [response handling](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).
