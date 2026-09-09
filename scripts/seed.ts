/**
 * Seeds the real staff, services, and hours from src/config/business.ts.
 * Idempotent: safe to re-run. Wipes bookings only with --fresh.
 */
import { loadEnv } from '../src/env';
loadEnv();

import { sql } from 'drizzle-orm';
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

  const staffIds = new Map<string, string>();
  for (const name of SEED_STAFF) {
    const [row] = await db.insert(staff).values({ name }).returning();
    staffIds.set(name, row!.id);
  }
  console.log(`Staff: ${SEED_STAFF.join(', ')}`);

  const serviceIds = new Map<string, string>();
  for (const s of SEED_SERVICES) {
    const [row] = await db
      .insert(service)
      .values({
        name: s.name,
        durationMinutes: s.durationMinutes,
        priceRupiah: s.priceRupiah,
        bufferMinutes: DEFAULT_BUFFER_MINUTES,
      })
      .returning();
    serviceIds.set(s.name, row!.id);

    for (const staffName of s.staff) {
      await db.insert(staffService).values({
        staffId: staffIds.get(staffName)!,
        serviceId: row!.id,
      });
    }
  }
  console.log(`Services: ${SEED_SERVICES.map((s) => s.name).join(', ')}`);
  console.log('Bagas tidak melayani Cat Rambut (sengaja, untuk menguji suggestAlternatives).');

  for (const staffName of SEED_STAFF) {
    for (const h of OPENING_HOURS) {
      await db.insert(workingHours).values({
        staffId: staffIds.get(staffName)!,
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
