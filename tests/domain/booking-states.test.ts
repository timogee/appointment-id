/**
 * The state machine. Pure — the map and the guard, nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  SLOT_HOLDING_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  assertTransition,
  canTransition,
} from '../../src/domain/booking-states';
import { InvalidTransitionError } from '../../src/db/errors';

describe('TRANSITIONS', () => {
  it('lets a hold become confirmed or cancelled, and nothing else', () => {
    expect(TRANSITIONS.pending_payment).toEqual(['confirmed', 'cancelled']);
  });

  it('lets a confirmed booking end in any of the three real outcomes', () => {
    expect(new Set(TRANSITIONS.confirmed)).toEqual(new Set(['completed', 'no_show', 'cancelled']));
  });

  it('makes every terminal status a dead end', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(TRANSITIONS[status]).toEqual([]);
    }
  });

  it('never allows a booking to go back to pending_payment', () => {
    for (const targets of Object.values(TRANSITIONS)) {
      expect(targets).not.toContain('pending_payment');
    }
  });

  it('keeps SLOT_HOLDING_STATUSES in step with the DB exclusion constraint', () => {
    // Source of truth: the partial WHERE in src/db/migrations/0001_exclusion.sql.
    // If that predicate changes, this must change with it.
    expect(SLOT_HOLDING_STATUSES).toEqual(['pending_payment', 'confirmed']);
  });
});

describe('assertTransition', () => {
  it('permits a legal move', () => {
    expect(() => assertTransition('pending_payment', 'confirmed')).not.toThrow();
  });

  it('rejects an illegal move with a named error', () => {
    expect(() => assertTransition('cancelled', 'confirmed')).toThrow(InvalidTransitionError);
  });

  it('rejects reviving a no_show, because the record must stand', () => {
    expect(() => assertTransition('no_show', 'completed')).toThrow(InvalidTransitionError);
    expect(canTransition('no_show', 'cancelled')).toBe(false);
  });

  it('reports both ends of the rejected move', () => {
    try {
      assertTransition('completed', 'cancelled');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).from).toBe('completed');
      expect((error as InvalidTransitionError).to).toBe('cancelled');
    }
  });
});
