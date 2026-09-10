/**
 * TEMPLATE VERIFICATION — this is the exact shape documented in
 * .claude/skills/testing/SKILL.md. It runs so the documented template is
 * known to work, not merely plausible.
 */
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
