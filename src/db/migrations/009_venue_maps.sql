-- Venue map images and per-zone map coordinates, for the incident map
-- feature (Dashboard "Map" tab: click-to-place zone positions on an
-- uploaded venue map image, then plot live incidents on it by matching
-- their location's Section against a placed zone's label).

ALTER TABLE venues ADD COLUMN map_image BYTEA;
ALTER TABLE venues ADD COLUMN map_image_content_type TEXT;

-- Fractional (0-1) coordinates rather than pixels, so a placement stays
-- correct at any rendered size of the map image (responsive layout, or
-- a differently-sized replacement image uploaded later).
ALTER TABLE venue_zones ADD COLUMN map_x DOUBLE PRECISION;
ALTER TABLE venue_zones ADD COLUMN map_y DOUBLE PRECISION;