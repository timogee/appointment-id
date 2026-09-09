'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { service, staff } from '@/db/schema';
import { getAvailableSlots } from '@/domain/availability';
import { buildAvailabilityInput, loadQualifiedStaff } from '@/domain/availability-inputs';
import { createPendingBooking } from '@/domain/booking-service';
import { SlotTakenError } from '@/db/errors';
import { utcToJakartaTime, type JakartaDate } from '@/domain/time';

/**
 * The web page is the FALLBACK surface. It calls the same domain functions the
 * chat tools do — there is no second availability implementation here.
 */

export async function loadOptions() {
  const [services, allStaff] = await Promise.all([
    db.select().from(service).where(eq(service.active, true)),
    db.select().from(staff).where(eq(staff.active, true)),
  ]);
  return { services, staff: allStaff };
}

export async function loadSlots(serviceId: string, date: JakartaDate) {
  const qualified = await loadQualifiedStaff(db, serviceId);
  const now = new Date();

  const out = [];
  for (const s of qualified) {
    const input = await buildAvailabilityInput(db, {
      staffId: s.id,
      serviceId,
      date,
      notBefore: now,
    });
    out.push({
      staffId: s.id,
      staffName: s.name,
      closed: input.workingWindows.length === 0,
      slots: getAvailableSlots(input).map((slot) => ({
        startIso: slot.start.toISOString(),
        time: utcToJakartaTime(slot.start),
      })),
    });
  }
  return out;
}

export type BookResult =
  { ok: true; bookingId: string; instructions: string } | { ok: false; error: string };

export async function bookAction(input: {
  serviceId: string;
  staffId: string;
  startIso: string;
  phone: string;
  name: string;
}): Promise<BookResult> {
  const phone = input.phone.replace(/\D/g, '').replace(/^0/, '62');
  if (phone.length < 9) return { ok: false, error: 'Nomor WhatsApp-nya kurang lengkap.' };

  try {
    const result = await createPendingBooking({
      customerPhone: phone,
      customerName: input.name || undefined,
      staffId: input.staffId,
      serviceId: input.serviceId,
      startTime: new Date(input.startIso),
      source: 'web',
      actor: { kind: 'customer', phone },
    });
    return {
      ok: true,
      bookingId: result.booking.id,
      instructions: result.dp.instructions,
    };
  } catch (error) {
    if (error instanceof SlotTakenError) {
      // The database refused it. Say so honestly rather than pretending it worked.
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
