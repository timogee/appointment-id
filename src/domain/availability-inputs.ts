/**
 * The ONLY bridge from Postgres to the pure engine in src/domain/availability.ts.
 * Everything here is I/O; everything there is arithmetic. Keep it that way — it
 * is why the engine's test suite needs no database.
 */
import { and, eq, inArray, lt, gt } from 'drizzle-orm';
import { db, type Queryer } from '@/db/client';
import { booking, service, staff, staffService, timeOff, workingHours } from '@/db/schema';
import { DEFAULT_BUFFER_MINUTES } from '@/config/business';
import { NotFoundError } from '@/db/errors';
import { SLOT_HOLDING_STATUSES } from './booking-states';
import type { AvailabilityInput, Interval, StaffAvailabilityInput } from './availability';
import {
  jakartaDayBounds,
  jakartaDayOfWeek,
  jakartaToUtc,
  nextDate,
  type JakartaDate,
} from './time';

/**
 * Working windows for one staff member on one Jakarta calendar date, as UTC instants.
 * A Jakarta day runs 17:00 UTC (prev day) to 17:00 UTC, which is exactly why this
 * conversion happens here and not in SQL.
 */
export async function loadWorkingWindows(
  q: Queryer,
  staffId: string,
  date: JakartaDate,
): Promise<Interval[]> {
  const dow = jakartaDayOfWeek(date);
  const rows = await q
    .select()
    .from(workingHours)
    .where(and(eq(workingHours.staffId, staffId), eq(workingHours.dayOfWeek, dow)));

  // No row for this weekday means closed. Senin has no rows: Senin libur.
  return rows.map((r) => ({
    start: jakartaToUtc(date, r.openTime),
    end: jakartaToUtc(date, r.closeTime),
  }));
}

/** Time off plus every slot-holding booking that intersects the day. */
export async function loadBusy(
  q: Queryer,
  staffId: string,
  from: Date,
  to: Date,
): Promise<Interval[]> {
  const [offRows, bookingRows] = await Promise.all([
    q
      .select()
      .from(timeOff)
      .where(and(eq(timeOff.staffId, staffId), lt(timeOff.startsAt, to), gt(timeOff.endsAt, from))),
    q
      .select()
      .from(booking)
      .where(
        and(
          eq(booking.staffId, staffId),
          // Only slot-holding statuses block. cancelled and no_show free their slot,
          // exactly as the partial WHERE in 0001_exclusion.sql does.
          inArray(booking.status, [...SLOT_HOLDING_STATUSES]),
          lt(booking.startTime, to),
          gt(booking.endTime, from),
        ),
      ),
  ]);

  return [
    ...offRows.map((r) => ({ start: r.startsAt, end: r.endsAt })),
    ...bookingRows.map((r) => ({ start: r.startTime, end: r.endTime })),
  ];
}

export async function loadServiceOrThrow(q: Queryer, serviceId: string) {
  const [row] = await q.select().from(service).where(eq(service.id, serviceId)).limit(1);
  if (!row) throw new NotFoundError('Layanan');
  return row;
}

export async function loadStaffOrThrow(q: Queryer, staffId: string) {
  const [row] = await q.select().from(staff).where(eq(staff.id, staffId)).limit(1);
  if (!row) throw new NotFoundError('Staff');
  return row;
}

/** Staff qualified for a service, active only. Bagas is absent for Cat Rambut. */
export async function loadQualifiedStaff(q: Queryer, serviceId: string) {
  return q
    .select({ id: staff.id, name: staff.name })
    .from(staffService)
    .innerJoin(staff, eq(staff.id, staffService.staffId))
    .where(and(eq(staffService.serviceId, serviceId), eq(staff.active, true)));
}

export async function isQualified(
  q: Queryer,
  staffId: string,
  serviceId: string,
): Promise<boolean> {
  const [row] = await q
    .select({ staffId: staffService.staffId })
    .from(staffService)
    .where(and(eq(staffService.staffId, staffId), eq(staffService.serviceId, serviceId)))
    .limit(1);
  return Boolean(row);
}

/** Assemble the pure input for one staff member on one date. */
export async function buildAvailabilityInput(
  q: Queryer,
  params: { staffId: string; serviceId: string; date: JakartaDate; notBefore?: Date },
): Promise<AvailabilityInput> {
  const svc = await loadServiceOrThrow(q, params.serviceId);
  const [workingWindows, busy] = await Promise.all([
    loadWorkingWindows(q, params.staffId, params.date),
    // Widen by a day on each side so a booking that starts before midnight and
    // runs past it still registers as busy.
    loadBusy(
      q,
      params.staffId,
      jakartaDayBounds(nextDate(params.date, -1)).start,
      jakartaDayBounds(nextDate(params.date)).end,
    ),
  ]);

  return {
    workingWindows,
    busy,
    durationMinutes: svc.durationMinutes,
    bufferMinutes: svc.bufferMinutes || DEFAULT_BUFFER_MINUTES,
    ...(params.notBefore ? { notBefore: params.notBefore } : {}),
  };
}

/** Same, but for every qualified staff member across a date range. */
export async function buildPerStaffInputs(
  q: Queryer,
  params: { serviceId: string; dates: ReadonlyArray<JakartaDate>; notBefore?: Date },
): Promise<StaffAvailabilityInput[]> {
  const qualified = await loadQualifiedStaff(q, params.serviceId);
  const out: StaffAvailabilityInput[] = [];

  for (const s of qualified) {
    for (const date of params.dates) {
      const input = await buildAvailabilityInput(q, {
        staffId: s.id,
        serviceId: params.serviceId,
        date,
        ...(params.notBefore ? { notBefore: params.notBefore } : {}),
      });
      if (input.workingWindows.length === 0) continue;
      out.push({ ...input, staffId: s.id, staffName: s.name });
    }
  }
  return out;
}

export { db };
