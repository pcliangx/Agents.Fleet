# R0-13 Notification Gateway prototype

Risk prototype for `RT-MOD-11`, `RT-NOTIFY-01..06`, `RT-T-28`, `SV1-DATA-09`,
and `SV1-T-23`. It demonstrates a durable SQLite outbox, bounded delivery retry,
idempotent recovery from a post-display Daemon crash, minimal lock-screen
content, and authenticated Task/Attempt activation.

This directory is not the production R3 integration. In particular, the
external notification boundary is a persistent fake that models the macOS
requirement to replace/coalesce a notification by stable identity.

## Ownership seams

- `AuthoritativeAttemptWriter` owns the transaction that changes an Attempt
  and inserts its Notification Intent. It is separate from the gateway.
- `NotificationGateway` reads only durable intents and mutates only delivery
  state and delivery observations. It cannot create or change Attempt facts.
- `SystemNotificationCenter` is the external-system adapter. It receives a
  fixed, bounded payload and stable `notificationId`.
- `NotificationActivationAuthenticator` models Electron Main authentication.
  The authenticated stable route is then sent to the Daemon-owned gateway,
  which checks it again against the persisted intent before acknowledgement.

## Files

- `notification-outbox.ts` — real `node:sqlite` schema, atomic outbox writer,
  dedupe key, and strict persisted route parser.
- `notification-gateway.ts` — delivery, payload bound, bounded retry,
  observations, and authenticated acknowledgement.
- `notification-security.ts` — fixed activation envelope, HMAC authentication,
  exact Task/Attempt route validation, and tamper rejection.
- `persistent-fake-notification-center.ts` — durable external-boundary fake
  whose stable ID semantics make post-display replay visibly idempotent.
- `children/gateway-child.ts` — real child process killed after the external
  side effect and before the lifecycle DB update.
- `driver.ts` / `evidence.ts` — reproducible 20-check probe and evidence writer.
- `*.test.ts` — focused transaction, delivery, crash, and security fixtures.

## Reproduce

```sh
pnpm prototype:r0-13
pnpm exec vitest run packages/daemon/src/prototypes/r0-13-notification-gateway/*.test.ts
```

The first command regenerates
[`docs/probes/r0-13/evidence.json`](../../../../../docs/probes/r0-13/evidence.json).
Probe policy values are fixtures, not normative RuntimeLimitProfile defaults.
See the
[probe report](../../../../../docs/probes/r0-13-notification-gateway.md)
for measured results and production follow-ups.
