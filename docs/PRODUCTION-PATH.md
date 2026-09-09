# Production path

What changes to take this from prototype to live, in order. **Steps and file
paths only — no code is written until Timo says so.**

Nothing here is a rewrite. Every step is either a new file behind an existing
interface, a registry branch, or an operational task. That is the whole point of
the `provider-interfaces` design.

> The Meta platform rules in step 2 are as specified at the time of writing.
> Re-check them against Meta's current developer docs before implementing —
> WhatsApp policy has changed repeatedly, and a stale assumption here costs a
> blocked number rather than a failed test.

---

## 1. Real admin auth

Replaces the single env password.

| File                              | Change                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/app/admin/auth.ts`           | Replace `isAdmin`/`signIn`/`signOut` with a real session. Keep the same three exported functions so callers do not move. |
| `src/app/admin/actions.ts`        | No change — `requireAdmin()` already gates every action.                                                                 |
| `src/db/migrations/0002_user.sql` | New `app_user` table: id, phone or email, password hash, role, created_at.                                               |
| `src/db/schema.ts`                | Add the table.                                                                                                           |
| `src/domain/audit.ts`             | `Actor` already has `{ kind: 'owner', id }`. Start passing the real user id; `actorId()` needs no change.                |
| `.env.example`                    | Remove `ADMIN_PASSWORD`, add the session secret.                                                                         |

Why it is additive: `booking_audit.actor_id` has stored an actor string since day
one. Existing rows keep saying `owner`; new rows say `owner:<uuid>`. No backfill,
no migration of history.

Do not skip: rate-limit the login route, and set the session cookie
`httpOnly` + `secure` + `sameSite=lax`.

---

## 2. WhatsApp Cloud API — sending and receiving

Two new files plus one route. Neither exists yet.

| File                                        | Purpose                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/providers/notifier/whatsapp-cloud.ts`  | `WhatsAppCloudNotifier implements Notifier`                                                  |
| `src/providers/inbound/whatsapp-webhook.ts` | `WhatsAppWebhookAdapter implements InboundAdapter`                                           |
| `src/app/api/whatsapp/route.ts`             | `GET` for Meta's verify handshake, `POST` for messages                                       |
| `src/providers/registry.ts`                 | One branch each in `buildNotifier()` and `buildInbound()`                                    |
| `.env.example`                              | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |

Then set `NOTIFIER=whatsapp_cloud` and `INBOUND_ADAPTER=whatsapp_webhook`.
**No calling code changes.**

### Platform constraints that shape the design

- **The 24-hour window.** Free-form messages deliver only within 24 hours of the
  customer's last inbound message. Outside it, only an approved template
  delivers. Anything the system sends on its own schedule — a reminder, a
  hold-expiry warning — is outside the window by definition.
- **Utility templates are free inside an open window.** Sending a template while
  the window is open costs nothing, so there is no reason to branch on window
  state to save money. Branch on it only for correctness.
- **New numbers are capped at 250 business-initiated conversations per 24
  hours.** For one barbershop this is comfortable, but the reminder job must not
  fan out unbounded. Cap it and log when it hits the cap.
- **Cloud API numbers require a configured billing method** on the Meta account,
  even at zero spend. Do this before the migration window in step 4, not during.
- **General-purpose AI bots have been banned since January 2026; task-specific
  bots are allowed.** Our tool-only design is on the allowed side — the model can
  only check availability, book, cancel, look up, and hand off. **Keep it that
  way.** Do not add a general-knowledge or open-chat tool. The six-tool ceiling in
  `.claude/skills/chat-tools/SKILL.md` is a compliance boundary, not only a design
  preference.

### Also required in the webhook

Verify `X-Hub-Signature-256` against `WHATSAPP_APP_SECRET` and reject on
mismatch. Meta retries on non-2xx, so acknowledge fast and process
asynchronously, and make `handleInbound` idempotent on the message id — a
duplicate delivery must not double-book.

---

## 3. Message templates to get approved

Three, submitted in Meta Business Manager before go-live. Approval takes hours to
days; do it early.

All three are **utility** templates. Variables are positional `{{1}}`, `{{2}}`, …
and the copy stays casual Indonesian, matching `src/chat/prompt.ts`.

### `booking_confirmed` — sent when the owner presses "DP diterima"

> Halo kak {{1}}, DP kamu udah kami terima. Booking {{2}} sama {{3}} hari {{4}}
> jam {{5}} udah fix ya. Sampai ketemu di Barberkuy Kemang! 🙌

`{{1}}` nama · `{{2}}` layanan · `{{3}}` staff · `{{4}}` hari dan tanggal ·
`{{5}}` jam

### `booking_reminder_h1` — H-1, sent the day before

> Halo kak {{1}}, ingetin aja ya, besok kamu ada jadwal {{2}} sama {{3}} jam
> {{4}}. Kalau mau ubah atau batal, bales chat ini aja.

`{{1}}` nama · `{{2}}` layanan · `{{3}}` staff · `{{4}}` jam

Trigger and job design belong to `booking-lifecycle`; copy `hold-expiry.ts`.

### `hold_expiring_warning` — sent before the hold lapses

> Halo kak {{1}}, slot {{2}} jam {{3}} masih kami tahan sampai jam {{4}}. Kalau
> DP {{5}} belum masuk sampai jam segitu, slotnya kami lepas ya. Kalau udah
> transfer, kirim aja fotonya ke sini.

`{{1}}` nama · `{{2}}` hari dan tanggal · `{{3}}` jam booking · `{{4}}` batas
waktu · `{{5}}` nominal DP

Note: the _expiry_ message in `src/domain/hold-expiry.ts` is a reply to a
customer who messaged recently, so it usually lands inside the 24-hour window and
can stay free-form. The _warning_ above is proactive and needs the template.
When in doubt, use the template — it delivers either way.

---

## 4. Number migration checklist

The client's number **cannot run on the WhatsApp Business app and the Cloud API
at the same time.** Migrating moves it off the app they currently use to run the
shop. Treat this as a scheduled maintenance window.

1. Agree a window with the owner **outside business hours** — the shop is closed
   Senin, which makes Monday the obvious choice. Never during opening hours.
2. The owner must be present and reachable the whole time: verification codes go
   to them, not to you.
3. Before the window: Meta Business account verified, billing method configured
   (step 2), templates submitted and **approved** (step 3), webhook deployed and
   answering the `GET` verify handshake on production.
4. Export chat history from the WhatsApp Business app first. It does **not** come
   across, and the owner will expect it to.
5. Tell regular customers a day ahead that the number may be quiet briefly.
6. Migrate: register the number on Cloud API, complete two-factor, point the
   webhook at production.
7. Verify end to end with a real handset before declaring done — send an inbound
   message, confirm the bot replies, book a real slot, confirm the DP, cancel it.
8. Keep `NOTIFIER=console` until step 7 passes, then flip. One env var is the
   rollback.

Have a rollback plan the owner understands: if the bot misbehaves, set
`NOTIFIER=console` and answer manually. The shop keeps running.

---

## 5. Optional: MidtransProvider

Only if the owner asks for automatic payment confirmation. Manual transfer is not
a limitation to be fixed — it is what this tier of business actually uses.

| File                                | Change                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| `src/providers/payment/midtrans.ts` | `MidtransProvider implements PaymentProvider`                      |
| `src/providers/registry.ts`         | One branch in `buildPayments()`                                    |
| `src/app/api/midtrans/route.ts`     | Webhook that flips `payment_record.status`                         |
| `package.json`                      | The SDK — the one dependency this project has deliberately refused |

**Non-negotiable: the Midtrans account is registered under the CLIENT's legal
entity, NPWP, and bank account. Never the developer's.** A gateway in the
developer's name routes the client's revenue into the developer's account and
makes it the developer's taxable income. If the client is not ready to register,
the answer is to keep manual transfer, not to register it yourself "for now".

The webhook must move the booking through `confirmDpReceived` so the state
machine and the audit row still apply. It must not `UPDATE booking` directly.

---

## 6. Operations

**Backups.** Nightly `pg_dump` to off-site storage, 30-day retention. Test a
restore into a scratch database before go-live — an untested backup is a guess.
`booking_audit` and `payment_record` are the rows that cannot be reconstructed.

**Error tracking.** Sentry or equivalent, wired into the webhook route, the
server actions, and every scheduled job. Two errors must page rather than log:
a `booking_no_overlap` violation surfacing to a customer, and a notifier failure —
the first means the availability engine disagrees with the database, the second
means customers are being silently ignored.

**Scheduled jobs.** `npm run expire-holds` every 5 minutes and the H-1 reminder
job once daily, on a real scheduler with alerting on failure. A hold job that
stops silently locks the calendar within a day.

**Log retention.** 30 days. Redact message bodies — they contain customer names
and phone numbers. Log the phone number hashed, not raw.

**Monitoring worth having on day one:** count of `pending_payment` bookings older
than the hold window (should be zero), handoff threads unanswered for over an
hour, and inbound messages that produced no tool call.
