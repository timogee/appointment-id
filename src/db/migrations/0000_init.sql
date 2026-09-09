-- Barberkuy booking schema.
-- INVARIANTS: every instant is timestamptz (UTC). Every money column is integer rupiah.
-- The one exception to "no local wall-clock" is working_hours.open_time/close_time,
-- which are recurring Asia/Jakarta rules, not instants. See src/domain/time.ts.

CREATE TYPE booking_status AS ENUM (
  'pending_payment',
  'confirmed',
  'cancelled',
  'no_show',
  'completed'
);

CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'expired');

CREATE TABLE customer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL UNIQUE,          -- E.164 without '+', e.g. 6281234567890
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  price_rupiah     integer NOT NULL CHECK (price_rupiah >= 0),
  buffer_minutes   integer NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  active           boolean NOT NULL DEFAULT true
);

CREATE TABLE staff_service (
  staff_id   uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

-- Recurring weekly availability. day_of_week: 0=Sunday .. 6=Saturday (JS getDay order).
-- Times are Asia/Jakarta wall-clock; materialised to UTC per calendar date.
CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time   time NOT NULL,
  close_time  time NOT NULL,
  CHECK (close_time > open_time)
);

-- Ad-hoc unavailability. Real instants, unlike working_hours.
CREATE TABLE time_off (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text,
  CHECK (ends_at > starts_at)
);

CREATE TABLE booking (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customer (id),
  staff_id        uuid NOT NULL REFERENCES staff (id),
  service_id      uuid NOT NULL REFERENCES service (id),
  status          booking_status NOT NULL,
  start_time      timestamptz NOT NULL,
  -- end_time already includes the service buffer; the slot a booking OCCUPIES is
  -- what the exclusion constraint compares, so buffer must be inside it.
  end_time        timestamptz NOT NULL,
  slot            tstzrange NOT NULL
                    GENERATED ALWAYS AS (tstzrange(start_time, end_time, '[)')) STORED,
  price_rupiah    integer NOT NULL CHECK (price_rupiah >= 0),
  hold_expires_at timestamptz,
  source          text NOT NULL DEFAULT 'chat',   -- chat | web | walkin | admin
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  -- a hold expiry is meaningful only while the booking is holding a slot unpaid
  CHECK ((status = 'pending_payment') = (hold_expires_at IS NOT NULL))
);

CREATE INDEX booking_staff_start_idx ON booking (staff_id, start_time);
CREATE INDEX booking_status_hold_idx ON booking (status, hold_expires_at);

-- Every booking mutation writes one of these, in the same transaction.
CREATE TABLE booking_audit (
  id         bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES booking (id) ON DELETE CASCADE,
  actor_id   text NOT NULL,   -- 'system' | 'owner' | 'phone:628...' ; real auth later fills this
  action     text NOT NULL,
  before     jsonb,
  after      jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX booking_audit_booking_idx ON booking_audit (booking_id, created_at);

-- Manual transfer by design: the system stores evidence, the owner decides.
CREATE TABLE payment_record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES booking (id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'manual_transfer',
  reference       text NOT NULL UNIQUE,
  amount_rupiah   integer NOT NULL CHECK (amount_rupiah >= 0),
  status          payment_status NOT NULL DEFAULT 'pending',
  proof_image_url text,             -- customer's bukti transfer. NEVER verified by the system.
  confirmed_by    text,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_record_booking_idx ON payment_record (booking_id);

-- Chat sessions, so handoff state survives a restart and the admin can see flagged threads.
CREATE TABLE chat_session (
  phone            text PRIMARY KEY,
  handed_off       boolean NOT NULL DEFAULT false,
  handoff_reason   text,
  handoff_at       timestamptz,
  unresolved_turns integer NOT NULL DEFAULT 0,
  tool_errors      integer NOT NULL DEFAULT 0,
  transcript       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
