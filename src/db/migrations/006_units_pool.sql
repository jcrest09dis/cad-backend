-- Units can now exist without being tied to an event yet - a reusable
-- roster (e.g. "Medic 1", "Bike Team A") that gets assigned to a
-- specific event later, the same way staff are pooled and checked into
-- events rather than recreated per event. A unit with event_id = NULL
-- won't appear on any event's live dispatch board (GET
-- /events/:eventId/units still filters by event_id) until assigned.
ALTER TABLE units
  ALTER COLUMN event_id DROP NOT NULL;
