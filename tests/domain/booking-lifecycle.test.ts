/**
 * Booking mutations against a real database: audit rows, hold expiry, walk-ins.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, db } from '../../src/db/client';
import { booking, bookingAudit, paymentRecord } from '../../src/db/schema';
import {
  cancelBooking,
  confirmDpReceived,
  createPendingBooking,
  createWalkIn,
  getBookingsForPhone,
  markCompleted,
  markNoShow,
} from '../../src/domain/booking-service';
import { releaseExpiredHolds } from '../../src/domain/hold-expiry';
import { InvalidTransitionError, SlotTakenError, DomainError } from '../../src/db/errors';
import { ConsoleNotifier } from '../../src/providers/notifier/console';
import { setProviders, resetProviders } from '../../src/providers/registry';
import { addMinutes } from '../../src/domain/time';
import { resetDb, seedFixture, type Fixture } from '../helpers/db';

let fx: Fixture;
let notifier: ConsoleNotifier;

const PHONE = '628111000222';
const START = new Date('2026-09-10T04:00:00Z'); // Kamis 11:00 WIB

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

const potong = () => ({
  customerPhone: PHONE,
  staffId: fx.staff.Clara!,
  serviceId: fx.services['Potong Rambut Pria']!,
  startTime: START,
  actor: { kind: 'customer' as const, phone: PHONE },
});

describe('createPendingBooking', () => {
  it('holds the slot, sets an expiry, and writes an audit row', async () => {
    const { booking: row } = await createPendingBooking(potong());

    expect(row.status).toBe('pending_payment');
    expect(row.holdExpiresAt).not.toBeNull();
    // end_time includes the buffer: 45 + 10.
    expect(row.endTime.getTime() - row.startTime.getTime()).toBe(55 * 60_000);

    const audit = await db.select().from(bookingAudit).where(eq(bookingAudit.bookingId, row.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('create_pending');
    expect(audit[0]!.actorId).toBe(`phone:${PHONE}`);
    expect(audit[0]!.before).toBeNull();
    expect((audit[0]!.after as { status: string }).status).toBe('pending_payment');
  });

  it('creates a pending manual-transfer payment record', async () => {
    const { booking: row, dp } = await createPendingBooking(potong());
    const [pay] = await db.select().from(paymentRecord).where(eq(paymentRecord.bookingId, row.id));

    expect(pay!.provider).toBe('manual_transfer');
    expect(pay!.status).toBe('pending');
    expect(pay!.amountRupiah).toBe(50_000);
    // Money is an integer, never a formatted string, in the database.
    expect(Number.isInteger(pay!.amountRupiah)).toBe(true);
    expect(dp.instructions).toContain('BCA');
  });

  it('refuses a staff member not qualified for the service', async () => {
    // Karyn does not do Cat Rambut.
    await expect(
      createPendingBooking({
        ...potong(),
        staffId: fx.staff.Karyn!,
        serviceId: fx.services['Cat Rambut']!,
      }),
    ).rejects.toThrow(DomainError);
  });

  it('surfaces a taken slot as SlotTakenError, from the DB constraint', async () => {
    await createPendingBooking(potong());
    await expect(createPendingBooking(potong())).rejects.toThrow(SlotTakenError);
  });
});

describe('owner actions', () => {
  it('confirms DP, flips the payment record, and notifies the customer', async () => {
    const { booking: row } = await createPendingBooking(potong());
    const confirmed = await confirmDpReceived(row.id, { kind: 'owner' }, 'https://x/bukti.jpg');

    expect(confirmed.status).toBe('confirmed');
    // The hold is gone: a confirmed booking does not expire.
    expect(confirmed.holdExpiresAt).toBeNull();

    const [pay] = await db.select().from(paymentRecord).where(eq(paymentRecord.bookingId, row.id));
    expect(pay!.status).toBe('paid');
    // The system STORES the bukti; it never verifies it.
    expect(pay!.proofImageUrl).toBe('https://x/bukti.jpg');

    expect(notifier.sent.at(-1)?.toPhone).toBe(PHONE);
  });

  it('records a no_show without deleting it', async () => {
    const { booking: row } = await createPendingBooking(potong());
    await confirmDpReceived(row.id, { kind: 'owner' });
    await markNoShow(row.id, { kind: 'owner' });

    const [after] = await db.select().from(booking).where(eq(booking.id, row.id));
    // The row survives. The owner needs this number.
    expect(after!.status).toBe('no_show');

    const audit = await db.select().from(bookingAudit).where(eq(bookingAudit.bookingId, row.id));
    expect(audit.map((a) => a.action)).toEqual(['create_pending', 'confirm_dp', 'no_show']);
  });

  it('refuses an illegal transition', async () => {
    const { booking: row } = await createPendingBooking(potong());
    await cancelBooking(row.id, { kind: 'owner' });
    await expect(markCompleted(row.id, { kind: 'owner' })).rejects.toThrow(InvalidTransitionError);
  });

  it('writes before and after snapshots on every mutation', async () => {
    const { booking: row } = await createPendingBooking(potong());
    await confirmDpReceived(row.id, { kind: 'owner' });

    const [confirm] = await db
      .select()
      .from(bookingAudit)
      .where(and(eq(bookingAudit.bookingId, row.id), eq(bookingAudit.action, 'confirm_dp')));

    expect((confirm!.before as { status: string }).status).toBe('pending_payment');
    expect((confirm!.after as { status: string }).status).toBe('confirmed');
    expect(confirm!.actorId).toBe('owner');
  });
});

describe('walk-ins', () => {
  it('creates a confirmed booking starting now', async () => {
    const now = new Date('2026-09-10T05:00:00Z');
    const row = await createWalkIn({
      customerPhone: '628999',
      staffId: fx.staff.Carla!,
      serviceId: fx.services['Potong Rambut Pria']!,
      actor: { kind: 'owner' },
      now,
    });
    expect(row.status).toBe('confirmed');
    expect(row.source).toBe('walkin');
    expect(row.holdExpiresAt).toBeNull();
  });

  it('contends for the same constraint — there is no bypass path', async () => {
    const now = new Date('2026-09-10T05:00:00Z');
    const params = {
      customerPhone: '628999',
      staffId: fx.staff.Carla!,
      serviceId: fx.services['Potong Rambut Pria']!,
      actor: { kind: 'owner' as const },
      now,
    };
    await createWalkIn(params);
    await expect(createWalkIn(params)).rejects.toThrow(SlotTakenError);
  });
});

describe('releaseExpiredHolds', () => {
  it('cancels an expired hold, notifies, audits, and frees the slot', async () => {
    const { booking: row } = await createPendingBooking(potong());

    // Push the hold into the past rather than waiting an hour.
    await db
      .update(booking)
      .set({ holdExpiresAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(booking.id, row.id));

    const result = await releaseExpiredHolds(new Date('2026-01-02T00:00:00Z'));
    expect(result.expired.map((e) => e.bookingId)).toEqual([row.id]);

    const [after] = await db.select().from(booking).where(eq(booking.id, row.id));
    expect(after!.status).toBe('cancelled');
    expect(after!.holdExpiresAt).toBeNull();

    const [pay] = await db.select().from(paymentRecord).where(eq(paymentRecord.bookingId, row.id));
    expect(pay!.status).toBe('expired');

    const audit = await db.select().from(bookingAudit).where(eq(bookingAudit.bookingId, row.id));
    expect(audit.map((a) => a.action)).toContain('hold_expired');
    expect(audit.find((a) => a.action === 'hold_expired')!.actorId).toBe('system');

    expect(notifier.sent.at(-1)?.body).toMatch(/slotnya kami lepas/i);

    // The freed slot is bookable again.
    await expect(createPendingBooking(potong())).resolves.toBeTruthy();
  });

  it('leaves a hold that has not expired alone', async () => {
    const { booking: row } = await createPendingBooking(potong());
    const result = await releaseExpiredHolds(addMinutes(new Date(), -1));
    expect(result.expired).toEqual([]);
    const [after] = await db.select().from(booking).where(eq(booking.id, row.id));
    expect(after!.status).toBe('pending_payment');
  });

  it('never touches a confirmed booking', async () => {
    const { booking: row } = await createPendingBooking(potong());
    await confirmDpReceived(row.id, { kind: 'owner' });
    const result = await releaseExpiredHolds(new Date('2030-01-01T00:00:00Z'));
    expect(result.expired).toEqual([]);
  });
});

describe('getBookingsForPhone', () => {
  it('returns active bookings only by default', async () => {
    const { booking: a } = await createPendingBooking(potong());
    const { booking: b } = await createPendingBooking({
      ...potong(),
      startTime: new Date('2026-09-10T06:00:00Z'),
    });
    await cancelBooking(b.id, { kind: 'customer', phone: PHONE });

    const active = await getBookingsForPhone(PHONE);
    expect(active.map((r) => r.id)).toEqual([a.id]);

    const all = await getBookingsForPhone(PHONE, { includeTerminal: true });
    expect(all).toHaveLength(2);
  });
});

describe('hold expiry is measured from the request time', () => {
  it('uses the supplied now rather than the process clock', async () => {
    const now = new Date('2026-09-09T07:00:00Z');
    const { booking: row } = await createPendingBooking({ ...potong(), now });
    // 60 minutes after the message arrived, not 60 minutes after this test ran.
    expect(row.holdExpiresAt!.toISOString()).toBe('2026-09-09T08:00:00.000Z');
  });
});
