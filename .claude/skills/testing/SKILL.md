---
name: testing
description: >-
  Use when WRITING OR FIXING A TEST in this repo: which of the two test shapes to
  use, the shared database fixtures, injecting fake providers, why the suite is
  serial, and how to run a subset. Covers tests/helpers/db.ts, tests/setup.ts,
  vitest.config.ts and the conventions every test file follows. Symptoms it owns:
  "test hangs", "tests interfere with each other", "how do I seed data for a
  test", "test needs a notifier". NOT for what to assert about slots, statuses or
  tools — load availability-engine, booking-lifecycle or chat-tools for the
  behaviour itself.
---

# Testing

    npm test                              everything, offline, no API key
    npx vitest run tests/domain           one directory
    npx vitest run -t "frees the slot"    one test by name

Requires Postgres up (`docker compose up -d --wait`) and migrated (`npm run db:migrate`).

## Two shapes. Pick the right one.

**Pure** — no database, no clock, no providers. Used by
`tests/domain/availability.test.ts`, `date-parser.test.ts`,
`booking-states.test.ts`. Import the function, call it, assert. These run in
milliseconds; keep them that way and never import `tests/helpers/db.ts` into one.

**Database-backed** — the second template below. Used by
`tests/db/overlap-constraint.test.ts`, `tests/domain/booking-lifecycle.test.ts`,
`tests/chat/engine.test.ts`, `tests/chat/transcript-replay.test.ts`.

Both templates below are verified, not aspirational:
`tests/domain/template-pure-check.test.ts` and
`tests/domain/template-check.test.ts` are these exact files and run with the rest
of the suite. If you change a template here, change it there and watch it pass.

## Template 1 — pure

Reach for this first. Most behaviour in this repo is arithmetic and does not need
Postgres. For the signatures of the functions under test, load the skill that owns
them — `availability-engine` here.

```ts
import { describe, expect, it } from 'vitest';
import { getAvailableSlots } from '../../src/domain/availability';
import { jakartaToUtc, utcToJakartaTime } from '../../src/domain/time';

/** Slot starts as Jakarta 'HH:mm' — how a human checks this against shop hours. */
const times = (slots: Array<{ start: Date }>) => slots.map((s) => utcToJakartaTime(s.start));
const at = (date: string, time: string) => jakartaToUtc(date, time);

describe('getAvailableSlots', () => {
  it('does not offer a slot that would overlap an existing booking', () => {
    const slots = getAvailableSlots({
      workingWindows: [{ start: at('2026-09-10', '10:00'), end: at('2026-09-10', '12:00') }],
      busy: [{ start: at('2026-09-10', '10:00'), end: at('2026-09-10', '10:55') }],
      durationMinutes: 45,
      bufferMinutes: 10,
    });

    expect(times(slots)).not.toContain('10:00');
    expect(times(slots)).toContain('11:00');
  });
});
```

`times()` and `at()` are two-line local helpers, redeclared per file on purpose —
they are shorter than importing them and they keep each test readable on its own.

## Template 2 — database-backed

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../../src/db/client';
import { booking } from '../../src/db/schema';
import { createPendingBooking } from '../../src/domain/booking-service';
import { ConsoleNotifier } from '../../src/providers/notifier/console';
import { setProviders, resetProviders } from '../../src/providers/registry';
import { resetDb, seedFixture, type Fixture } from '../helpers/db';

let fx: Fixture;
let notifier: ConsoleNotifier;

beforeEach(async () => {
  await resetDb();
  fx = await seedFixture();
  notifier = new ConsoleNotifier();
  setProviders({ notifier });
});

afterAll(async () => {
  resetProviders();
  await closeDb();
});

describe('template', () => {
  it('books a slot and can assert on both the row and the notification', async () => {
    const { booking: row } = await createPendingBooking({
      customerPhone: '628111000999',
      staffId: fx.staff.Maria!,
      serviceId: fx.services['Potong Rambut Pria']!,
      startTime: new Date('2026-09-10T04:00:00Z'),
      now: new Date('2026-09-09T07:00:00Z'),
      actor: { kind: 'customer', phone: '628111000999' },
    });

    expect(row.status).toBe('pending_payment');

    const [persisted] = await db.select().from(booking).where(eq(booking.id, row.id));
    expect(persisted!.priceRupiah).toBe(65_000);
    expect(notifier.sent).toEqual([]);
  });
});
```

Only four helpers are documented here, and each is used by half the suite:
`resetDb`, `seedFixture`, `setProviders`/`resetProviders`, `ConsoleNotifier`.
Anything narrower belongs in the skill that owns the subject —
`ScriptedChatModel`, for instance, is documented in `chat-tools`.

## The fixtures

`tests/helpers/db.ts`:

- `resetDb()` — `TRUNCATE … CASCADE` over every table. Call it in `beforeEach`,
  not `beforeAll`; leakage between cases is worse than the second it costs.
- `seedFixture()` — returns `{ staff, services }`, both name → id maps.
  Staff: `Maria`, `Clara`, `Bagas`. Services: `Potong Rambut Pria` (45 min,
  Rp 65.000) and `Cat Rambut` (90 min, Rp 250.000), buffer 10.
  **Bagas is not qualified for Cat Rambut** — the same asymmetry the real seed
  has, so tests exercise the unqualified-staff path production will hit.
  Working hours match `OPENING_HOURS`, so Senin is closed in tests too.

## Rules that keep this suite honest

**Always `await closeDb()` in `afterAll`.** The pg pool keeps handles open and
vitest hangs at the end without it. This is the most common failure mode here.

**Never assert on wall-clock now.** Pass an explicit `now`/`receivedAt`. Every
time-sensitive function takes one: `createPendingBooking({ now })`,
`releaseExpiredHolds(now)`, `parseIndonesianDate(text, now)`,
`handleInbound({ receivedAt })`.

**Write times as `jakartaToUtc('2026-09-10', '15:00')`,** not raw UTC strings, so
a reader can check them against real shop hours. Assert with a helper that
converts back — see the `times()` helper in `availability.test.ts`.

**Inject providers, never reach for env.** `setProviders({ notifier })` in
`beforeEach` and `resetProviders()` in `afterAll`. `ConsoleNotifier.sent` is an
array you can assert on.

**Prove concurrency with concurrency.** Two sequential inserts are not a race. Use
two `pool.connect()` clients with two open transactions — see
`tests/db/overlap-constraint.test.ts` >
`"lets exactly one of two concurrent overlapping inserts win"`.

**The suite must run offline.** No `ANTHROPIC_API_KEY`, no network — the registry
falls back automatically (see `provider-interfaces` for why). A test that only
passes with an API key is broken.

## Why the suite is serial

`vitest.config.ts` sets `fileParallelism: false`. Every DB-backed file truncates
the same Postgres, so parallel files would pull the rug out from under each other.
Do not turn it on to make things faster; make the pure tests carry more of the
load instead. `tests/setup.ts` loads `.env` for every file.
