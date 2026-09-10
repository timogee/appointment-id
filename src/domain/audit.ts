/**
 * Every booking mutation writes one audit row, in the same transaction as the
 * mutation. If a code path changes a booking without calling this, that is a bug.
 */
import { bookingAudit, type BookingRow } from '@/db/schema';
import type { Queryer } from '@/db/client';

/** Who did it. Real auth later supplies a user id here without changing the shape. */
export type Actor =
  { kind: 'system' } | { kind: 'owner'; id?: string } | { kind: 'customer'; phone: string };

export function actorId(actor: Actor): string {
  switch (actor.kind) {
    case 'system':
      return 'system';
    case 'owner':
      return actor.id ? `owner:${actor.id}` : 'owner';
    case 'customer':
      return `phone:${actor.phone}`;
  }
}

/** The subset of a booking worth snapshotting. Keeps audit rows readable. */
function snapshot(row: BookingRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    status: row.status,
    staffId: row.staffId,
    serviceId: row.serviceId,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
    priceRupiah: row.priceRupiah,
    holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
  };
}

export async function writeAudit(
  tx: Queryer,
  params: {
    bookingId: string;
    actor: Actor;
    action: string;
    before: BookingRow | null;
    after: BookingRow | null;
  },
): Promise<void> {
  await tx.insert(bookingAudit).values({
    bookingId: params.bookingId,
    actorId: actorId(params.actor),
    action: params.action,
    before: snapshot(params.before),
    after: snapshot(params.after),
  });
}
