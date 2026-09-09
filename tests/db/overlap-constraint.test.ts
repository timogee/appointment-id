/**
 * The exclusion constraint is the product. If these fail, nothing else matters.
 *
 * These tests use two SEPARATE connections with two OPEN transactions, so the
 * conflict is arbitrated by Postgres under real concurrency — not by ordering
 * two sequential inserts and calling it a race.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { db, closeDb, pool } from '../../src/db/client';
import { booking, customer } from '../../src/db/schema';
import { SlotTakenError, translatePgError } from '../../src/db/errors';
import { resetDb, seedFixture, type Fixture } from '../helpers/db';

let fx: Fixture;
let customerId: string;

const START = new Date('2026-09-10T03:00:00Z'); // Kamis 10:00 WIB
const END = new Date('2026-09-10T03:55:00Z'); // 45 min + 10 min buffer

beforeEach(async () => {
  await resetDb();
  fx = await seedFixture();
  const [c] = await db.insert(customer).values({ phone: '628111000111' }).returning();
  customerId = c!.id;
});

afterAll(async () => {
  await closeDb();
});

function values(overrides: Partial<typeof booking.$inferInsert> = {}) {
  return {
    customerId,
    staffId: fx.staff.Maria!,
    serviceId: fx.services['Potong Rambut Pria']!,
    status: 'confirmed' as const,
    startTime: START,
    endTime: END,
    priceRupiah: 65_000,
    ...overrides,
  };
}

/** Raw INSERT on a dedicated connection, so two can be in flight at once. */
async function rawInsert(client: pg.PoolClient, v: typeof booking.$inferInsert) {
  return client.query(
    `INSERT INTO booking (customer_id, staff_id, service_id, status, start_time, end_time, price_rupiah, hold_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      v.customerId,
      v.staffId,
      v.serviceId,
      v.status,
      v.startTime,
      v.endTime,
      v.priceRupiah,
      v.holdExpiresAt ?? null,
    ],
  );
}

describe('booking_no_overlap', () => {
  it('lets exactly one of two concurrent overlapping inserts win', async () => {
    const a = await pool.connect();
    const b = await pool.connect();

    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      // A takes 10:00-10:55. B wants 10:30-11:25 with the same staff.
      await rawInsert(a, values());

      // B blocks on the exclusion constraint until A resolves. Start it now and
      // only then commit A, so the two really are concurrent.
      const bInsert = rawInsert(
        b,
        values({
          startTime: new Date('2026-09-10T03:30:00Z'),
          endTime: new Date('2026-09-10T04:25:00Z'),
        }),
      );

      await a.query('COMMIT');

      let domainError: unknown;
      try {
        await bInsert;
        await b.query('COMMIT');
      } catch (error) {
        await b.query('ROLLBACK');
        try {
          translatePgError(error);
        } catch (translated) {
          domainError = translated;
        }
      }

      expect(domainError).toBeInstanceOf(SlotTakenError);
      expect((domainError as SlotTakenError).code).toBe('SLOT_TAKEN');
      // A friendly Indonesian message, not a Postgres error string.
      expect((domainError as Error).message).not.toMatch(/exclusion|23P01|gist/i);

      const rows = await db.select().from(booking);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.startTime.toISOString()).toBe(START.toISOString());
    } finally {
      a.release();
      b.release();
    }
  });

  it('allows back-to-back bookings because the range is half-open', async () => {
    await db.insert(booking).values(values());
    await db
      .insert(booking)
      .values(values({ startTime: END, endTime: new Date('2026-09-10T04:50:00Z') }));
    expect(await db.select().from(booking)).toHaveLength(2);
  });

  it('frees the slot when a booking is cancelled (the partial WHERE clause)', async () => {
    const [first] = await db.insert(booking).values(values()).returning();
    await expect(db.insert(booking).values(values())).rejects.toThrow();

    await db.update(booking).set({ status: 'cancelled' }).where(eq(booking.id, first!.id));

    // Same interval, same staff, now legal — and the cancelled row is still there.
    await db.insert(booking).values(values());
    const rows = await db.select().from(booking);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(1);
  });

  it('frees the slot on no_show while KEEPING the record', async () => {
    const [first] = await db.insert(booking).values(values()).returning();
    await db.update(booking).set({ status: 'no_show' }).where(eq(booking.id, first!.id));

    await db.insert(booking).values(values());

    const rows = await db.select().from(booking);
    expect(rows).toHaveLength(2);
    // The owner needs this number. no_show is never deleted.
    expect(rows.some((r) => r.status === 'no_show')).toBe(true);
  });

  it('blocks a slot held by an unpaid pending_payment booking', async () => {
    await db
      .insert(booking)
      .values(
        values({ status: 'pending_payment', holdExpiresAt: new Date('2026-09-10T04:00:00Z') }),
      );
    await expect(db.insert(booking).values(values())).rejects.toThrow();
  });

  it('does not constrain different staff at the same time', async () => {
    await db.insert(booking).values(values());
    await db.insert(booking).values(values({ staffId: fx.staff.Clara! }));
    expect(await db.select().from(booking)).toHaveLength(2);
  });
});
