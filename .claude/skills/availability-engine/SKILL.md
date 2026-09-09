---
name: availability-engine
description: >-
  Use when working on WHICH TIMES CAN BE OFFERED or on the database overlap
  guarantee: computing free slots, suggesting alternatives, working hours,
  time-off, buffers, slot granularity, double-booking, or the btree_gist
  exclusion constraint. Covers src/domain/availability.ts,
  availability-inputs.ts, and src/db/migrations/0001_exclusion.sql. Symptoms it
  owns: "offered a slot that was already taken", "cancelled bookings still block
  the slot", "no slots showing", "wrong slots near closing time". NOT for what
  happens to a booking AFTER it exists — status changes, hold expiry, audit
  rows, walk-ins — that is booking-lifecycle. NOT for how the bot phrases or
  chooses what to say, which is chat-tools.
---

# Availability engine

Two layers, deliberately split:

| File                                | Job                    | Has I/O?       |
| ----------------------------------- | ---------------------- | -------------- |
| `src/domain/availability.ts`        | the arithmetic         | no — pure      |
| `src/domain/availability-inputs.ts` | Postgres → pure inputs | yes, all of it |

The split is why `tests/domain/availability.test.ts` needs no database. Keep new
arithmetic in the pure file and new queries in the loader.

## Slots are computed, never stored

There is no slot table and there must never be one. A pre-generated slot row set
drifts from reality the moment a booking, a time-off, or an hours change lands.
`getAvailableSlots` derives everything each call. The real signatures:

```ts
interface Interval {
  start: Date;
  end: Date;
} // UTC instants

interface AvailabilityInput {
  workingWindows: ReadonlyArray<Interval>; // that Jakarta date, from working_hours
  busy: ReadonlyArray<Interval>; // time off + slot-holding bookings
  durationMinutes: number; // the service, excluding buffer
  bufferMinutes: number; // gap kept after the service
  stepMinutes?: number; // default SLOT_STEP_MINUTES (15)
  notBefore?: Date; // usually "now"
}

interface Slot {
  start: Date; // when the customer arrives
  end: Date; // when the service ends — what the customer is told
  occupiedEnd: Date; // end + buffer — what the DB constraint compares
}

function getAvailableSlots(input: AvailabilityInput): Slot[]; // chronological
```

One options object, not positional arguments. The result is always sorted by
`start`; there is no ranking or scoring — the caller picks.

`suggestAlternatives` takes its own input and returns two lists:

```ts
function suggestAlternatives(input: {
  perStaff: ReadonlyArray<AvailabilityInput & { staffId: string; staffName: string }>;
  preferredStaffId?: string;
  wantedStart?: Date; // matched on exact start; never re-offered
  limit?: number; // default 5, applied per list
}): {
  sameStaffOtherTimes: Array<{ staffId: string; staffName: string; slot: Slot }>;
  sameTimeOtherStaff: Array<{ staffId: string; staffName: string; slot: Slot }>;
};
```

Both lists are sorted by time and capped at `limit`. `checkAvailability` and
`suggestAlternatives` in the chat layer both bottom out in `getAvailableSlots` —
there is one implementation, not two.

## Staff qualification is a filter, not part of the arithmetic

`getAvailableSlots` knows nothing about who can do what. Qualification lives in
`staff_service` and is applied by the loader:

Every loader takes `q: Queryer` as its first argument — the type from
`src/db/client.ts`, which is `Db | Tx`, so the same function works against the
pool or inside an open transaction. Pass `db` from a read path and `tx` from
inside `db.transaction(...)`.

- `loadQualifiedStaff(q, serviceId)` — active staff who can perform a service.
  Used by `checkAvailability` when no staff was named, and by
  `buildPerStaffInputs`.
- `isQualified(q, staffId, serviceId)` — used by `createPendingBooking` to reject
  a booking with an unqualified staff member (`DomainError`).

In the seed, Bagas is not qualified for Cat Rambut. That asymmetry is deliberate:
it is what makes `sameTimeOtherStaff` testable.

A booking OCCUPIES `duration + buffer`. The customer is told `end`; the constraint
compares `occupiedEnd`. The service itself must finish before closing; the trailing
buffer may run past it, because the staff member is tidying up, not serving.

`suggestAlternatives` returns `sameStaffOtherTimes` and `sameTimeOtherStaff`. It is
a first-class function rather than a caller-side loop because it is the most
valuable thing the bot does: when the answer is no, say what the answer _is_.

## The exclusion constraint — the product

`src/db/migrations/0001_exclusion.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (staff_id WITH =, slot WITH &&)
  WHERE (status IN ('pending_payment','confirmed'));
```

`booking.slot` is a GENERATED column — `tstzrange(start_time, end_time, '[)')` —
so it can never disagree with the times. The `[)` bound is why back-to-back
bookings are legal without a special case: touching ranges do not overlap. The
pure engine mirrors this in its `overlaps()` helper; if you change one bound,
change both.

### Why the partial WHERE clause exists

Only `pending_payment` and `confirmed` hold a slot. Widen that predicate and a
no-show blocks its slot forever — but the row must still exist, because the owner
needs that number. Narrow it and an unpaid hold stops holding.

That list is mirrored in TypeScript as `SLOT_HOLDING_STATUSES`
(`src/domain/booking-states.ts`), used by `loadBusy` to filter. The predicate and
the constant must stay in step; `tests/domain/booking-states.test.ts` >
`"keeps SLOT_HOLDING_STATUSES in step with the DB exclusion constraint"` fails if
they drift. **Source of truth is the SQL.**

### Never replace it with an application check

Two concurrent requests both pass an application-level "is it free?" check and
both insert. Postgres arbitrates; `SELECT`-then-`INSERT` does not. If the
constraint ever seems not to work, stop and report it — do not add a code-level
overlap check.

`src/db/errors.ts` is the ONLY place a pg error becomes a domain error. It
translates `23P01` on `booking_no_overlap` into `SlotTakenError` and walks the
`.cause` chain, because Drizzle wraps driver errors — a real bug once hidden here.

## Adding a new scheduling constraint safely

1. Decide whether it is arithmetic or data. Arithmetic → `availability.ts`. A new
   source of unavailability → a table plus a `loadBusy`-style query in
   `availability-inputs.ts` that feeds the existing `busy` array. Prefer the
   second: `busy` already composes.
2. If it must be _impossible_ rather than merely _not offered_, it belongs in a
   migration as a constraint, not in TypeScript.
3. Add a pure test to `tests/domain/availability.test.ts` first. Write times as
   `jakartaToUtc(date, 'HH:mm')` and assert with the `times()` helper so a reader
   can check them against real shop hours without doing UTC maths.
4. If you touched the constraint or its predicate, add a case to
   `tests/db/overlap-constraint.test.ts` using two pooled connections in two open
   transactions — sequential inserts do not prove concurrency.
5. Run `npm test` and `npm run check`.

## Business facts are read, not remembered

Opening hours, service durations, prices, buffer and DP amount all live in
`src/config/business.ts`. Read that file when you need a value; never hard-code
one into a test or copy it into a doc. It is the file that changes when the
client changes, and any copy of it silently goes stale.

## Jakarta, not UTC

A Jakarta calendar day starts at 17:00 UTC the previous day. Use
`jakartaDayBounds`, `jakartaDateKey`, `jakartaToUtc` from `src/domain/time.ts` —
never `getDate()` on a raw `Date`. `working_hours.open_time`/`close_time` are the
one place wall-clock is stored, because they are recurring rules rather than
instants; `loadWorkingWindows` materialises them per date.

Covered by `tests/domain/availability.test.ts` >
`"handles a slot spanning local midnight without leaking into the wrong day"`.
