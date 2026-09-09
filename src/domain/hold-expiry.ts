/**
 * Releases pending_payment bookings whose hold ran out.
 *
 * Built once, properly, because everything that ever holds a slot without
 * payment reuses it: chat bookings today, gateway-pending bookings later.
 * Nothing else may expire a booking.
 */
import { and, eq, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { booking, customer, paymentRecord, service, staff } from '@/db/schema';
import { assertTransition } from './booking-states';
import { writeAudit } from './audit';
import { formatInstantId } from './time';
import { getProviders } from '@/providers/registry';

export interface ExpiryResult {
  expired: Array<{ bookingId: string; phone: string; whenLabel: string }>;
}

export async function releaseExpiredHolds(now = new Date()): Promise<ExpiryResult> {
  const due = await db
    .select({ booking, phone: customer.phone, serviceName: service.name, staffName: staff.name })
    .from(booking)
    .innerJoin(customer, eq(customer.id, booking.customerId))
    .innerJoin(service, eq(service.id, booking.serviceId))
    .innerJoin(staff, eq(staff.id, booking.staffId))
    .where(and(eq(booking.status, 'pending_payment'), lt(booking.holdExpiresAt, now)));

  const expired: ExpiryResult['expired'] = [];
  const { notifier } = getProviders();

  for (const row of due) {
    const before = row.booking;
    assertTransition(before.status, 'cancelled');

    // One transaction per booking: a notification failure on one customer must
    // not roll back the release of another's slot.
    const after = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(booking)
        .set({ status: 'cancelled', holdExpiresAt: null, updatedAt: now })
        .where(and(eq(booking.id, before.id), eq(booking.status, 'pending_payment')))
        .returning();
      if (!updated) return null; // someone confirmed it between the read and here

      await tx
        .update(paymentRecord)
        .set({ status: 'expired' })
        .where(eq(paymentRecord.bookingId, before.id));

      await writeAudit(tx, {
        bookingId: before.id,
        actor: { kind: 'system' },
        action: 'hold_expired',
        before,
        after: updated,
      });
      return updated;
    });

    if (!after) continue;

    const whenLabel = formatInstantId(before.startTime);
    await notifier.sendText(
      row.phone,
      `Halo kak, DP buat ${row.serviceName} sama ${row.staffName} (${whenLabel}) belum masuk, ` +
        `jadi slotnya kami lepas dulu ya. Kalau masih mau, chat aja lagi nanti kami carikan jam kosong. 🙏`,
    );
    expired.push({ bookingId: before.id, phone: row.phone, whenLabel });
  }

  return { expired };
}
