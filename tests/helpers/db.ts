/**
 * Shared fixtures for tests that need a real database.
 * Pure-function tests (availability, date parser, state machine) must NOT import this.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { service, staff, staffService, workingHours } from '../../src/db/schema';
import { DEFAULT_BUFFER_MINUTES, OPENING_HOURS } from '../../src/config/business';

export async function resetDb(): Promise<void> {
  await db.execute(
    sql`TRUNCATE booking, booking_audit, payment_record, customer, chat_session, staff_service, working_hours, time_off, staff, service CASCADE`,
  );
}

export interface Fixture {
  staff: Record<string, string>;
  services: Record<string, string>;
}

/**
 * Clara and Carla do everything; Karyn does not do Cat Rambut. Mirrors the real
 * seed in scripts/seed.ts so tests exercise the same asymmetry production has.
 */
export async function seedFixture(): Promise<Fixture> {
  const staffIds: Record<string, string> = {};
  for (const name of ['Clara', 'Carla', 'Karyn']) {
    const [row] = await db.insert(staff).values({ name }).returning();
    staffIds[name] = row!.id;
  }

  const serviceIds: Record<string, string> = {};
  const defs = [
    {
      name: 'Potong Rambut Pria',
      durationMinutes: 45,
      priceRupiah: 65_000,
      staff: ['Clara', 'Carla', 'Karyn'],
    },
    { name: 'Cat Rambut', durationMinutes: 90, priceRupiah: 250_000, staff: ['Clara', 'Carla'] },
  ];
  for (const d of defs) {
    const [row] = await db
      .insert(service)
      .values({
        name: d.name,
        durationMinutes: d.durationMinutes,
        priceRupiah: d.priceRupiah,
        bufferMinutes: DEFAULT_BUFFER_MINUTES,
      })
      .returning();
    serviceIds[d.name] = row!.id;
    for (const s of d.staff) {
      await db.insert(staffService).values({ staffId: staffIds[s]!, serviceId: row!.id });
    }
  }

  for (const name of Object.keys(staffIds)) {
    for (const h of OPENING_HOURS) {
      await db.insert(workingHours).values({
        staffId: staffIds[name]!,
        dayOfWeek: h.dayOfWeek,
        openTime: h.open,
        closeTime: h.close,
      });
    }
  }

  return { staff: staffIds, services: serviceIds };
}
