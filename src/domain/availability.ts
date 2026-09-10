/**
 * Slot computation. PURE — no database, no clock, no I/O.
 *
 * Availability is COMPUTED from working hours, time off, existing bookings,
 * service duration and buffer. There is no slot table and there never will be
 * one: a pre-generated slot row set drifts from reality the moment a booking,
 * a time-off, or an hours change lands.
 *
 * The database loader that produces these inputs is src/domain/availability-inputs.ts.
 */
import { SLOT_STEP_MINUTES } from '@/config/business';
import { addMinutes } from './time';

export interface Interval {
  start: Date;
  end: Date;
}

export interface AvailabilityInput {
  /** Windows the staff member works, as UTC instants, already clipped to the day. */
  workingWindows: ReadonlyArray<Interval>;
  /** Time off and existing blocking bookings. Anything here is unavailable. */
  busy: ReadonlyArray<Interval>;
  /** Service duration in minutes, excluding buffer. */
  durationMinutes: number;
  /** Gap kept after the service. The occupied interval is duration + buffer. */
  bufferMinutes: number;
  /** Offered start times land on this grid. */
  stepMinutes?: number;
  /** Slots starting before this are not offered. Usually "now". */
  notBefore?: Date;
}

export interface Slot {
  /** When the customer arrives. */
  start: Date;
  /** When the service ends — what the customer is told. */
  end: Date;
  /** end + buffer. What the booking OCCUPIES and what the DB constraint compares. */
  occupiedEnd: Date;
}

function overlaps(a: Interval, b: Interval): boolean {
  // Half-open [start, end): touching intervals do not overlap, so back-to-back
  // bookings are legal. This matches tstzrange(start, end, '[)') in the DB.
  return a.start < b.end && b.start < a.end;
}

/**
 * All startable slots for one staff member on one day.
 * Returns them in chronological order.
 */
export function getAvailableSlots(input: AvailabilityInput): Slot[] {
  const step = input.stepMinutes ?? SLOT_STEP_MINUTES;
  const { durationMinutes, bufferMinutes } = input;
  const occupiedMinutes = durationMinutes + bufferMinutes;
  const slots: Slot[] = [];

  for (const window of input.workingWindows) {
    // Align the first candidate to the step grid measured from the window opening,
    // so a 10:00 open with a 15-min step offers 10:00, 10:15, ... not 10:07.
    for (
      let start = window.start;
      addMinutes(start, durationMinutes) <= window.end;
      start = addMinutes(start, step)
    ) {
      if (input.notBefore && start < input.notBefore) continue;

      const end = addMinutes(start, durationMinutes);
      const occupiedEnd = addMinutes(start, occupiedMinutes);

      // The service itself must finish before close. The trailing buffer may run
      // past closing time — the staff member is tidying up, not serving.
      const candidate: Interval = { start, end: occupiedEnd };
      if (input.busy.some((b) => overlaps(candidate, b))) continue;

      slots.push({ start, end, occupiedEnd });
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface StaffAvailabilityInput extends AvailabilityInput {
  staffId: string;
  staffName: string;
}

export interface Alternatives {
  /** Other times, same staff member, across the searched range. */
  sameStaffOtherTimes: Array<{ staffId: string; staffName: string; slot: Slot }>;
  /** The originally wanted time, but with a different qualified staff member. */
  sameTimeOtherStaff: Array<{ staffId: string; staffName: string; slot: Slot }>;
}

export interface SuggestInput {
  /** Every qualified staff member's availability across the searched date range. */
  perStaff: ReadonlyArray<StaffAvailabilityInput>;
  /** The staff member the customer asked for, if any. */
  preferredStaffId?: string;
  /** The time the customer asked for, if any. Matched exactly on start. */
  wantedStart?: Date;
  /** Cap on each list. */
  limit?: number;
}

/**
 * The single most valuable thing the chat bot does: when the answer is "no",
 * say what the answer *is* instead of making the customer guess again.
 */
export function suggestAlternatives(input: SuggestInput): Alternatives {
  const limit = input.limit ?? 5;
  const sameStaffOtherTimes: Alternatives['sameStaffOtherTimes'] = [];
  const sameTimeOtherStaff: Alternatives['sameTimeOtherStaff'] = [];

  for (const staffInput of input.perStaff) {
    const slots = getAvailableSlots(staffInput);
    const isPreferred = staffInput.staffId === input.preferredStaffId;

    for (const slot of slots) {
      const entry = { staffId: staffInput.staffId, staffName: staffInput.staffName, slot };

      if (isPreferred || !input.preferredStaffId) {
        // Don't re-offer the exact time they already asked for and couldn't get.
        if (!input.wantedStart || slot.start.getTime() !== input.wantedStart.getTime()) {
          sameStaffOtherTimes.push(entry);
        }
      }

      if (
        !isPreferred &&
        input.wantedStart &&
        slot.start.getTime() === input.wantedStart.getTime()
      ) {
        sameTimeOtherStaff.push(entry);
      }
    }
  }

  const byTime = (a: { slot: Slot }, b: { slot: Slot }): number =>
    a.slot.start.getTime() - b.slot.start.getTime();

  return {
    sameStaffOtherTimes: sameStaffOtherTimes.sort(byTime).slice(0, limit),
    sameTimeOtherStaff: sameTimeOtherStaff.sort(byTime).slice(0, limit),
  };
}
