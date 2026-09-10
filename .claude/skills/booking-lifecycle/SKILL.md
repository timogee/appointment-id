---
name: booking-lifecycle
description: >-
  Use when working on WHAT HAPPENS TO A BOOKING THAT ALREADY EXISTS, including
  time-based jobs that act on bookings: statuses and allowed transitions,
  confirming a DP, cancelling, no-show, completed, the 60-minute hold and its
  expiry job, REMINDERS and any other scheduled or proactive message triggered by
  a booking, walk-ins, payment records, and booking_audit rows. Owns WHEN a
  message is sent — including a message that was never attempted because the job
  did not fire or picked no rows. If the job ran and the send was attempted but
  the customer got nothing, that is delivery: load provider-interfaces. Covers
  src/domain/booking-states.ts, booking-service.ts, hold-expiry.ts, audit.ts.
  Symptoms it owns: "booking stuck in the wrong status", "no audit row was
  written", "expired holds are not released", "add a reminder N hours before",
  "how do I add a state". NOT for deciding which times are free or for the
  overlap constraint itself — that is availability-engine. NOT for what the bot
  replies to an incoming chat message, which is chat-tools.
---

# Booking lifecycle

## The state machine

`src/domain/booking-states.ts` holds the single `TRANSITIONS` map. Nothing else
may decide whether a status change is legal.

```
pending_payment ──> confirmed ──> completed
       │                │    └──> no_show
       └──> cancelled   └──> cancelled
```

| Status            | Meaning                                          | Holds a slot? |
| ----------------- | ------------------------------------------------ | ------------- |
| `pending_payment` | reserved, DP not yet seen; has `hold_expires_at` | yes           |
| `confirmed`       | owner acknowledged the DP arrived                | yes           |
| `cancelled`       | terminal, frees the slot                         | no            |
| `no_show`         | terminal, frees the slot, **kept on the record** | no            |
| `completed`       | terminal                                         | no            |

Terminal states are dead ends: `TRANSITIONS[terminal]` is `[]`. Nothing ever
returns to `pending_payment`.

### Why no_show is never deleted

The owner needs that number. It is how they decide whether to keep accepting
bookings from a customer who does not pay a DP. Deleting the row would free the
slot _and_ destroy the reason to care. The partial WHERE on the exclusion
constraint already frees the slot while the row stands — see the
`availability-engine` skill for that predicate.

## Every mutation goes through one function

`src/domain/booking-service.ts` exposes `createPendingBooking`, `createWalkIn`,
`confirmDpReceived`, `cancelBooking`, `markNoShow`, `markCompleted`. All the
status changers delegate to a private `changeStatus`, which in one transaction:

1. reads the current row,
2. calls `assertTransition(before.status, to)` — throws `InvalidTransitionError`,
3. writes the update,
4. writes the `booking_audit` row.

Because it is one transaction, a mutation cannot land without its audit row. If
you add a mutation, delegate to `changeStatus` rather than writing your own
`UPDATE` — that is the whole point of the indirection.

`hold_expires_at` is cleared on every move out of `pending_payment`. A DB CHECK
enforces `(status = 'pending_payment') = (hold_expires_at IS NOT NULL)`, so
forgetting this fails loudly rather than leaving a confirmed booking that expires.

## Audit rows

`src/domain/audit.ts` owns the shape. `actorId` is a string:
`'system'`, `'owner'`, or `'phone:628…'`. It exists now precisely so replacing the
env-password admin with real auth is additive — see `provider-interfaces` and
`docs/PRODUCTION-PATH.md`. `before`/`after` are trimmed JSON snapshots, not whole
rows, so the log stays readable.

## Holds and their expiry

A `pending_payment` booking holds its slot for `HOLD_MINUTES` (60,
`src/config/business.ts`). The expiry is measured from **when the request
arrived**, not the process clock: pass `now` into `createPendingBooking`. The chat
tool passes `ctx.now`. This keeps replay deterministic and stops a queued message
getting a hold that started before it was read.

`releaseExpiredHolds(now)` in `src/domain/hold-expiry.ts` is the only thing that
expires a booking. Per booking it opens its own transaction so one customer's
failed notification cannot roll back another's freed slot, and its `UPDATE` is
guarded by `status = 'pending_payment'` so a DP confirmed in the meantime wins.

Build on this rather than adding a second expiry path — gateway-pending bookings
will reuse it. Run it with `npm run expire-holds`.

## Scheduled messages triggered by a booking

Reminders, hold-expiry warnings, follow-ups: this skill owns **when** they fire
and **what booking state they act on**. `provider-interfaces` owns **how** they
are delivered.

`src/domain/hold-expiry.ts` is the pattern to copy, not to extend. It shows the
three things any such job must do:

1. Select the due rows with a single indexed query — `booking_status_hold_idx`
   exists for exactly this. A reminder job wants an equivalent predicate on
   `status = 'confirmed'` and a `start_time` window.
2. One transaction per booking, so one customer's failed send cannot roll back
   another's. Guard the `UPDATE` on the status you expected, so a booking that
   changed underneath you is skipped rather than clobbered.
3. Notify via `getProviders().notifier`, and write an audit row if the booking
   changed. A reminder that changes nothing needs no audit row — but it does need
   somewhere to record that it was sent, or a retry will send it twice.

A new job gets its own file in `src/domain/`, its own script in `scripts/`, and a
line in `CLAUDE.md`'s command list. Run it from cron in production.

Two constraints that will bite, both owned by `provider-interfaces` — read it
before writing the send: a reminder falls outside WhatsApp's 24-hour
customer-service window, so it must go through `sendTemplate` with a pre-approved
template, not `sendText`. The template copy itself is drafted in
`docs/PRODUCTION-PATH.md`.

## Walk-ins

`createWalkIn` sets `start_time = now`, status `confirmed`, `source = 'walkin'`,
no hold. It contends for the same exclusion constraint as everything else. There
is no bypass path and there must not be one:
`tests/domain/booking-lifecycle.test.ts` >
`"contends for the same constraint — there is no bypass path"`.

## Payments are manual by design

`createPendingBooking` also writes a `payment_record` with status `pending` via
`PaymentProvider.createDpRequest`. Only `confirmDpReceived` flips it to `paid`,
and only because the owner pressed "DP diterima" in `/admin`. The customer's
`proof_image_url` is stored and **never verified** — the system gathers evidence,
the human decides. Provider shape lives in `provider-interfaces`.

## Adding a new state

1. Add it to the `booking_status` pg enum in a NEW migration (Postgres enums are
   append-only; do not edit `0000_init.sql`). Migrations are named
   `NNNN_short_name.sql`, applied in filename order by `scripts/migrate.ts` and
   recorded in the `_migration` table — so the next one here is `0002_….sql`.
   An applied migration is never edited.
2. Add it to the enum in `src/db/schema.ts`.
3. Add its row and its edges to `TRANSITIONS`. TypeScript will flag every
   `Record<BookingStatus, …>` you now have to answer for.
4. Decide whether it holds a slot. If yes, add it to the constraint's WHERE clause
   in a new migration **and** to `SLOT_HOLDING_STATUSES`. If no, do neither.
5. Add a case to `tests/domain/booking-states.test.ts` and, if it holds a slot, to
   `tests/db/overlap-constraint.test.ts`.
6. `npm test && npm run check`.
