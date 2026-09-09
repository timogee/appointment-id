-- THE constraint. Overlapping bookings for one staff member are impossible at the
-- DATABASE level, not in application code.
--
-- The partial WHERE clause is required: 'cancelled' and 'no_show' bookings must FREE
-- their slot for reuse while staying on the record. Widening this predicate to all
-- statuses would make a no-show block its slot forever.
--
-- 'completed' is deliberately excluded too: it is terminal and in the past, and
-- including it would make backdated corrections impossible for no benefit.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (staff_id WITH =, slot WITH &&)
  WHERE (status IN ('pending_payment','confirmed'));
