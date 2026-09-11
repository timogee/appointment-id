/**
 * Seeds the real staff, services, and hours from src/config/business.ts.
 * Idempotent: safe to re-run. Wipes bookings only with --fresh.
 */
import { loadEnv } from '../src/env';
loadEnv();

import { eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client';
import { service, staff, staffService, workingHours } from '../src/db/schema';
import {
  DEFAULT_BUFFER_MINUTES,
  OPENING_HOURS,
  SEED_SERVICES,
  SEED_STAFF,
  BUSINESS,
} from '../src/config/business';

async function main() {
  if (process.argv.includes('--fresh')) {
    await db.execute(
      sql`TRUNCATE booking, booking_audit, payment_record, customer, chat_session, staff_service, working_hours, time_off, staff, service CASCADE`,
    );
    console.log('Wiped existing data.');
  }

  // Match on name, the only human-stable key here: no unique constraint exists,
  // so a blind insert would duplicate the whole roster on every re-run.
  const staffIds = new Map<string, string>();
  for (const name of SEED_STAFF) {
    const [existing] = await db.select().from(staff).where(eq(staff.name, name)).limit(1);
    const row = existing ?? (await db.insert(staff).values({ name }).returning())[0];
    staffIds.set(name, row!.id);
  }
  console.log(`Staff: ${SEED_STAFF.join(', ')}`);

  const serviceIds = new Map<string, string>();
  for (const s of SEED_SERVICES) {
    const values = {
      name: s.name,
      durationMinutes: s.durationMinutes,
      priceRupiah: s.priceRupiah,
      bufferMinutes: DEFAULT_BUFFER_MINUTES,
    };
    const [existing] = await db.select().from(service).where(eq(service.name, s.name)).limit(1);
    // Update rather than skip: editing a price in business.ts and re-seeding
    // should move the price, not silently leave the old one in place.
    const row = existing
      ? (await db.update(service).set(values).where(eq(service.id, existing.id)).returning())[0]
      : (await db.insert(service).values(values).returning())[0];
    serviceIds.set(s.name, row!.id);

    // Replace the roster wholesale so a staff member removed from a service
    // in business.ts actually loses it here.
    await db.delete(staffService).where(eq(staffService.serviceId, row!.id));
    for (const staffName of s.staff) {
      await db.insert(staffService).values({
        staffId: staffIds.get(staffName)!,
        serviceId: row!.id,
      });
    }
  }
  console.log(`Services: ${SEED_SERVICES.map((s) => s.name).join(', ')}`);
  console.log('Karyn tidak melayani Cat Rambut (sengaja, untuk menguji suggestAlternatives).');

  for (const staffName of SEED_STAFF) {
    const staffId = staffIds.get(staffName)!;
    // Same reason as the roster: rewrite the week so changed hours take effect
    // and a day turned into a day off stops appearing.
    await db.delete(workingHours).where(eq(workingHours.staffId, staffId));
    for (const h of OPENING_HOURS) {
      await db.insert(workingHours).values({
        staffId,
        dayOfWeek: h.dayOfWeek,
        openTime: h.open,
        closeTime: h.close,
      });
    }
  }
  console.log(`Jam buka ${BUSINESS.name} tersimpan. Senin libur (tidak ada baris untuk hari 1).`);

  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
