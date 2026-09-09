/**
 * The booking state machine. This is the ONLY definition of which status
 * changes are legal, and assertTransition is the only gate. Nothing writes
 * booking.status without going through it.
 */
import { InvalidTransitionError } from '@/db/errors';
import type { BookingStatus } from '@/db/schema';

/**
 * pending_payment  holds the slot, has hold_expires_at
 * confirmed        owner acknowledged the DP arrived
 * cancelled        terminal, frees the slot
 * no_show          terminal, frees the slot, RECORDED NOT DELETED
 * completed        terminal
 *
 * no_show is a terminal state rather than a deletion because the owner needs
 * that number: it is how they decide whether to keep taking bookings from a
 * given customer without a DP.
 */
export const TRANSITIONS: Readonly<Record<BookingStatus, ReadonlyArray<BookingStatus>>> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'no_show', 'cancelled'],
  cancelled: [],
  no_show: [],
  completed: [],
};

export const TERMINAL_STATUSES: ReadonlyArray<BookingStatus> = [
  'cancelled',
  'no_show',
  'completed',
];

/** Statuses that hold a slot. Must match the partial WHERE in 0001_exclusion.sql. */
export const SLOT_HOLDING_STATUSES: ReadonlyArray<BookingStatus> = ['pending_payment', 'confirmed'];

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidTransitionError if the move is not on the map above. */
export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
