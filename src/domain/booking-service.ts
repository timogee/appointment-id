/**
 * Every booking mutation in the system. Each one:
 *   1. reads the current row,
 *   2. asserts the transition against src/domain/booking-states.ts,
 *   3. writes the change and a booking_audit row in ONE transaction,
 *   4. lets the DB exclusion constraint arbitrate overlaps.
 *
 * There is no bypass path. Walk-ins use createWalkIn, which contends for the
 * same constraint as everything else.
 */
import { and, eq, gte, lt, desc } from 'drizzle-orm';
import { db, type Queryer } from '@/db/client';
import { booking, customer, paymentRecord, type BookingRow, type BookingStatus } from '@/db/schema';
import { DomainError, NotFoundError, SlotTakenError, translatePgError } from '@/db/errors';
import { DP_AMOUNT_RUPIAH, HOLD_MINUTES } from '@/config/business';
import { addMinutes, jakartaDayBounds, type JakartaDate } from './time';
import { assertTransition } from './booking-states';
import { writeAudit, type Actor } from './audit';
import { isQualified, loadServiceOrThrow, loadStaffOrThrow } from './availability-inputs';
import { getProviders } from '@/providers/registry';

export async function upsertCustomer(q: Queryer, phone: string, displayName?: string) {
  const [row] = await q
    .insert(customer)
    .values({ phone, displayName: displayName ?? null })
    .onConflictDoUpdate({
      target: customer.phone,
      set: { displayName: displayName ?? null },
    })
    .returning();
  return row!;
}

export async function getBooking(q: Queryer, id: string): Promise<BookingRow> {
  const [row] = await q.select().from(booking).where(eq(booking.id, id)).limit(1);
  if (!row) throw new NotFoundError('Booking');
  return row;
}

export interface CreatePendingParams {
  customerPhone: string;
  customerName?: string;
  staffId: string;
  serviceId: string;
  /** UTC instant. Never a local wall-clock string. */
  startTime: Date;
  source?: string;
  actor: Actor;
  /**
   * When the request arrived. The hold is measured from this, not from the
   * process clock, so replay and tests are deterministic and a queued message
   * does not get a hold that started before it was read.
   */
  now?: Date;
}

/**
 * Reserve a slot. The booking holds it for HOLD_MINUTES, then the expiry job
 * releases it (src/domain/hold-expiry.ts).
 *
 * Overlap is NOT checked here. It is checked by booking_no_overlap, so two
 * concurrent callers cannot both win a race that an application-level check
 * would let through.
 */
export async function createPendingBooking(params: CreatePendingParams) {
  return db.transaction(async (tx) => {
    const svc = await loadServiceOrThrow(tx, params.serviceId);
    const staffRow = await loadStaffOrThrow(tx, params.staffId);

    if (!(await isQualified(tx, params.staffId, params.serviceId))) {
      throw new DomainError(`${staffRow.name} tidak melayani ${svc.name}.`);
    }

    const cust = await upsertCustomer(tx, params.customerPhone, params.customerName);
    // end_time includes the buffer: it is the interval the booking OCCUPIES.
    const endTime = addMinutes(params.startTime, svc.durationMinutes + svc.bufferMinutes);
    const holdExpiresAt = addMinutes(params.now ?? new Date(), HOLD_MINUTES);

    let created: BookingRow;
    try {
      const [row] = await tx
        .insert(booking)
        .values({
          customerId: cust.id,
          staffId: params.staffId,
          serviceId: params.serviceId,
          status: 'pending_payment',
          startTime: params.startTime,
          endTime,
          priceRupiah: svc.priceRupiah,
          holdExpiresAt,
          source: params.source ?? 'chat',
        })
        .returning();
      created = row!;
    } catch (error) {
      translatePgError(error);
    }

    await writeAudit(tx, {
      bookingId: created.id,
      actor: params.actor,
      action: 'create_pending',
      before: null,
      after: created,
    });

    // Manual transfer by design: this returns instructions, it does not charge anyone.
    const dp = await getProviders().payments.createDpRequest(created.id, DP_AMOUNT_RUPIAH);
    await tx.insert(paymentRecord).values({
      bookingId: created.id,
      provider: dp.provider,
      reference: dp.reference,
      amountRupiah: DP_AMOUNT_RUPIAH,
      status: 'pending',
    });

    return { booking: created, service: svc, staff: staffRow, dp };
  });
}

/** Walk-in: starts now, already confirmed, same constraint, no bypass. */
export async function createWalkIn(params: {
  customerPhone: string;
  customerName?: string;
  staffId: string;
  serviceId: string;
  actor: Actor;
  now?: Date;
}) {
  return db.transaction(async (tx) => {
    const svc = await loadServiceOrThrow(tx, params.serviceId);
    const cust = await upsertCustomer(tx, params.customerPhone, params.customerName);
    const startTime = params.now ?? new Date();
    const endTime = addMinutes(startTime, svc.durationMinutes + svc.bufferMinutes);

    let created: BookingRow;
    try {
      const [row] = await tx
        .insert(booking)
        .values({
          customerId: cust.id,
          staffId: params.staffId,
          serviceId: params.serviceId,
          status: 'confirmed',
          startTime,
          endTime,
          priceRupiah: svc.priceRupiah,
          holdExpiresAt: null,
          source: 'walkin',
        })
        .returning();
      created = row!;
    } catch (error) {
      translatePgError(error);
    }

    await writeAudit(tx, {
      bookingId: created.id,
      actor: params.actor,
      action: 'create_walkin',
      before: null,
      after: created,
    });
    return created;
  });
}

/**
 * The single status-change path. Every named mutation below delegates here so
 * the transition check and the audit row can never be forgotten.
 */
async function changeStatus(params: {
  bookingId: string;
  to: BookingStatus;
  action: string;
  actor: Actor;
  q?: Queryer;
}): Promise<BookingRow> {
  const run = async (tx: Queryer) => {
    const before = await getBooking(tx, params.bookingId);
    assertTransition(before.status, params.to);

    let after: BookingRow;
    try {
      const [row] = await tx
        .update(booking)
        .set({
          status: params.to,
          // hold_expires_at is meaningful only while pending_payment; the DB
          // CHECK constraint enforces that pairing, so clear it on every move out.
          holdExpiresAt: params.to === 'pending_payment' ? before.holdExpiresAt : null,
          updatedAt: new Date(),
        })
        .where(eq(booking.id, params.bookingId))
        .returning();
      after = row!;
    } catch (error) {
      translatePgError(error);
    }

    await writeAudit(tx, {
      bookingId: params.bookingId,
      actor: params.actor,
      action: params.action,
      before,
      after,
    });
    return after;
  };

  return params.q ? run(params.q) : db.transaction(run);
}

/** Owner pressed "DP diterima". The only way a booking becomes confirmed. */
export async function confirmDpReceived(bookingId: string, actor: Actor, proofImageUrl?: string) {
  const row = await db.transaction(async (tx) => {
    const updated = await changeStatus({
      bookingId,
      to: 'confirmed',
      action: 'confirm_dp',
      actor,
      q: tx,
    });
    await tx
      .update(paymentRecord)
      .set({
        status: 'paid',
        confirmedAt: new Date(),
        confirmedBy: 'owner',
        ...(proofImageUrl ? { proofImageUrl } : {}),
      })
      .where(eq(paymentRecord.bookingId, bookingId));
    return updated;
  });

  const { notifier } = getProviders();
  const phone = await phoneFor(row.id);
  await notifier.sendText(phone, `DP kamu udah kami terima. Booking kamu fix ya! 🙌`);
  return row;
}

export function cancelBooking(bookingId: string, actor: Actor) {
  return changeStatus({ bookingId, to: 'cancelled', action: 'cancel', actor });
}

/** Recorded, never deleted: the owner needs this number. */
export function markNoShow(bookingId: string, actor: Actor) {
  return changeStatus({ bookingId, to: 'no_show', action: 'no_show', actor });
}

export function markCompleted(bookingId: string, actor: Actor) {
  return changeStatus({ bookingId, to: 'completed', action: 'complete', actor });
}

/** Attach the customer's bukti transfer. The system stores it; it never verifies it. */
export async function attachPaymentProof(bookingId: string, url: string) {
  await db
    .update(paymentRecord)
    .set({ proofImageUrl: url })
    .where(eq(paymentRecord.bookingId, bookingId));
}

export async function phoneFor(bookingId: string): Promise<string> {
  const [row] = await db
    .select({ phone: customer.phone })
    .from(booking)
    .innerJoin(customer, eq(customer.id, booking.customerId))
    .where(eq(booking.id, bookingId))
    .limit(1);
  if (!row) throw new NotFoundError('Booking');
  return row.phone;
}

export async function getBookingsForPhone(phone: string, opts?: { includeTerminal?: boolean }) {
  const rows = await db
    .select({ booking, customerPhone: customer.phone })
    .from(booking)
    .innerJoin(customer, eq(customer.id, booking.customerId))
    .where(eq(customer.phone, phone))
    .orderBy(desc(booking.startTime));

  return opts?.includeTerminal
    ? rows.map((r) => r.booking)
    : rows
        .map((r) => r.booking)
        .filter((b) => b.status === 'pending_payment' || b.status === 'confirmed');
}

/** Everything on one Jakarta calendar day. Powers the admin page. */
export async function getBookingsForDate(date: JakartaDate) {
  const { start, end } = jakartaDayBounds(date);
  return db
    .select({ booking, customerPhone: customer.phone, customerName: customer.displayName })
    .from(booking)
    .innerJoin(customer, eq(customer.id, booking.customerId))
    .where(and(gte(booking.startTime, start), lt(booking.startTime, end)))
    .orderBy(booking.startTime);
}

export { SlotTakenError };
