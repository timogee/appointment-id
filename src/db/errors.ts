/**
 * The ONLY place a Postgres error becomes a domain error.
 * Nothing else in the codebase inspects pg error codes.
 */

/** The exclusion constraint fired: someone else holds that interval. */
export class SlotTakenError extends Error {
  readonly code = 'SLOT_TAKEN';
  constructor(message = 'Slot itu barusan keburu diambil orang lain.') {
    super(message);
    this.name = 'SlotTakenError';
  }
}

/** An attempted booking status change that the state machine forbids. */
export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Tidak bisa mengubah status booking dari ${from} ke ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(what: string) {
    super(`${what} tidak ditemukan.`);
    this.name = 'NotFoundError';
  }
}

/** Caller asked for something the business rules disallow (unqualified staff, closed day, ...). */
export class DomainError extends Error {
  readonly code = 'DOMAIN_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

const EXCLUSION_VIOLATION = '23P01';

/**
 * Drizzle wraps driver errors in DrizzleQueryError, so the pg fields live on
 * `.cause`. Walk the chain rather than assuming a depth — a wrapper added by a
 * future Drizzle version must not silently turn SlotTakenError back into a
 * raw 23P01 escaping to the customer.
 */
function unwrap(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function fieldOf(error: unknown, key: 'code' | 'constraint'): string | undefined {
  for (const link of unwrap(error)) {
    if (typeof link === 'object' && link !== null && key in link) {
      const value = (link as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

export function isOverlapViolation(error: unknown): boolean {
  return (
    fieldOf(error, 'code') === EXCLUSION_VIOLATION &&
    fieldOf(error, 'constraint') === 'booking_no_overlap'
  );
}

/**
 * Translate a driver error into a domain error, or rethrow it untouched.
 * Call this in the catch of every booking insert/update.
 */
export function translatePgError(error: unknown): never {
  if (isOverlapViolation(error)) {
    throw new SlotTakenError();
  }
  throw error;
}
