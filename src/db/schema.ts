/**
 * Table shapes. The authoritative DDL is src/db/migrations/*.sql — this file
 * mirrors it for typed queries. When they disagree, the migration wins.
 */
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** timestamptz, always. A naive local timestamp is a bug. */
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Generated column: tstzrange(start_time, end_time, '[)').
 * Drizzle never writes it; Postgres computes it. It exists so the exclusion
 * constraint in 0001_exclusion.sql has something to compare.
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
});

export const bookingStatus = pgEnum('booking_status', [
  'pending_payment',
  'confirmed',
  'cancelled',
  'no_show',
  'completed',
]);

export const paymentStatus = pgEnum('payment_status', ['pending', 'paid', 'expired']);

export const customer = pgTable('customer', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  displayName: text('display_name'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const staff = pgTable('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const service = pgTable('service', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  priceRupiah: integer('price_rupiah').notNull(),
  bufferMinutes: integer('buffer_minutes').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const staffService = pgTable(
  'staff_service',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'cascade' }),
  },
  (t) => [index('staff_service_service_idx').on(t.serviceId)],
);

/** Recurring weekly rule in Jakarta wall-clock. Not an instant. See src/domain/time.ts. */
export const workingHours = pgTable('working_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id')
    .notNull()
    .references(() => staff.id, { onDelete: 'cascade' }),
  dayOfWeek: smallint('day_of_week').notNull(),
  openTime: time('open_time').notNull(),
  closeTime: time('close_time').notNull(),
});

export const timeOff = pgTable('time_off', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id')
    .notNull()
    .references(() => staff.id, { onDelete: 'cascade' }),
  startsAt: tstz('starts_at').notNull(),
  endsAt: tstz('ends_at').notNull(),
  reason: text('reason'),
});

export const booking = pgTable(
  'booking',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => service.id),
    status: bookingStatus('status').notNull(),
    startTime: tstz('start_time').notNull(),
    /** Includes the service buffer: this is the interval the booking OCCUPIES. */
    endTime: tstz('end_time').notNull(),
    slot: tstzrange('slot').generatedAlwaysAs(sql`tstzrange(start_time, end_time, '[)')`),
    priceRupiah: integer('price_rupiah').notNull(),
    holdExpiresAt: tstz('hold_expires_at'),
    source: text('source').notNull().default('chat'),
    notes: text('notes'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('booking_staff_start_idx').on(t.staffId, t.startTime),
    index('booking_status_hold_idx').on(t.status, t.holdExpiresAt),
    check('booking_time_order', sql`end_time > start_time`),
  ],
);

export const bookingAudit = pgTable(
  'booking_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => booking.id, { onDelete: 'cascade' }),
    /** 'system' | 'owner' | 'phone:628...'. Real auth later fills this, additively. */
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('booking_audit_booking_idx').on(t.bookingId, t.createdAt)],
);

export const paymentRecord = pgTable(
  'payment_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => booking.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('manual_transfer'),
    reference: text('reference').notNull().unique(),
    amountRupiah: integer('amount_rupiah').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    /** The customer's bukti transfer. Evidence for the owner; never verified by us. */
    proofImageUrl: text('proof_image_url'),
    confirmedBy: text('confirmed_by'),
    confirmedAt: tstz('confirmed_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('payment_record_booking_idx').on(t.bookingId)],
);

export const chatSession = pgTable('chat_session', {
  phone: text('phone').primaryKey(),
  handedOff: boolean('handed_off').notNull().default(false),
  handoffReason: text('handoff_reason'),
  handoffAt: tstz('handoff_at'),
  unresolvedTurns: integer('unresolved_turns').notNull().default(0),
  toolErrors: integer('tool_errors').notNull().default(0),
  transcript: jsonb('transcript')
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type BookingRow = typeof booking.$inferSelect;
export type StaffRow = typeof staff.$inferSelect;
export type ServiceRow = typeof service.$inferSelect;
