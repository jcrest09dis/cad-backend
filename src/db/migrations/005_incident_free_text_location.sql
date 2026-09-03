-- Incident location becomes free text instead of a required predefined
-- zone. location_zone_id is kept (now nullable) purely so existing
-- incidents created before this change keep displaying correctly -
-- new incidents populate location_text and leave location_zone_id
-- null. venue_zones/the admin zone-management UI are untouched; they're
-- just no longer required for creating an incident.
ALTER TABLE incidents
  ALTER COLUMN location_zone_id DROP NOT NULL,
  ADD COLUMN location_text TEXT;
