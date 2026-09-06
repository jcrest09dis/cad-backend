-- Self-dispatch: a field unit assigning themselves to an incident
-- without waiting on a dispatcher. Recorded as a third, distinct
-- ack_method - this is neither a dispatcher-created assignment the
-- field device confirmed (self), nor a dispatcher's radio-confirmed
-- override (dispatcher_override), but something the unit originated
-- entirely on their own. Keeping it distinct preserves the same
-- "who did what and how" accountability the other two methods exist
-- for.
ALTER TABLE assignments
  DROP CONSTRAINT assignments_ack_method_check;

ALTER TABLE assignments
  ADD CONSTRAINT assignments_ack_method_check
  CHECK (ack_method IN ('self', 'dispatcher_override', 'self_initiated'));
