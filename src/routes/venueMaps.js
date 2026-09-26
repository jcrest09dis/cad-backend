import { pool } from '../db/pool.js';
import { requireAuth, requireEventMembership } from '../middleware/auth.js';

/**
 * Read-side venue map endpoints: serving the uploaded map image itself,
 * and (per-event) the zone positions plus open incidents plotted onto
 * those positions. Placement/upload itself is admin-only and lives in
 * admin.js - these are the endpoints the live dashboard's "Map" tab
 * actually polls, open to anyone checked into the event (dispatcher or
 * field staff), not just admins.
 */
export default async function venueMapRoutes(fastify) {
  // Raw image bytes for a venue's map. Not event-scoped since a venue
  // can host multiple events - just requires being logged in at all,
  // same trust level as the rest of the app's read paths (this isn't
  // PHI, just a facility map).
  fastify.get(
    '/venues/:venueId/map-image',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT map_image, map_image_content_type FROM venues WHERE id = $1`,
        [request.params.venueId]
      );
      if (rows.length === 0 || !rows[0].map_image) {
        reply.code(404).send({ error: 'no map image for this venue' });
        return;
      }
      reply
        .type(rows[0].map_image_content_type ?? 'application/octet-stream')
        .send(rows[0].map_image);
    }
  );

  // Everything the Map tab needs for one event in a single call: whether
  // the venue has a map image at all, every zone that's been placed on
  // it, and the currently-open incidents matched to a placed zone (when
  // possible) so they can be plotted as pins.
  //
  // Matching is best-effort, not a foreign key: incidents store free-text
  // location (see 005_incident_free_text_location.sql) as multi-line text
  // ("Section 224 (rows 2-30)\nRow 9\nSeat 30" - see NewIncidentPanel),
  // so only the first line (the Section value) is compared, and only
  // when it matches a zone's label exactly (trimmed, case-insensitive).
  // An incident whose Section was typed free-hand rather than chosen
  // from the suggestions list, or whose venue has no zone by that label
  // placed on the map yet, simply won't have a pin - it still shows up
  // in the normal incident list, this is additive, not a replacement.
  fastify.get(
    '/events/:eventId/map',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const { rows: eventRows } = await pool.query(
        `SELECT e.venue_id, (v.map_image IS NOT NULL) AS has_map_image
         FROM events e JOIN venues v ON v.id = e.venue_id
         WHERE e.id = $1`,
        [request.params.eventId]
      );
      if (eventRows.length === 0) {
        reply.code(404).send({ error: 'event not found' });
        return;
      }
      const { venue_id: venueId, has_map_image: hasMapImage } = eventRows[0];

      const { rows: zones } = await pool.query(
        `SELECT id, label, map_x, map_y FROM venue_zones
         WHERE venue_id = $1 AND map_x IS NOT NULL AND map_y IS NOT NULL`,
        [venueId]
      );
      const zoneByLabel = new Map(zones.map((z) => [z.label.trim().toLowerCase(), z]));

      const { rows: incidents } = await pool.query(
        `SELECT i.id, i.location_text, i.type, i.priority, i.status
         FROM incidents i
         WHERE i.event_id = $1 AND i.status IN ('OPEN', 'DISPATCHED')`,
        [request.params.eventId]
      );

      const plotted = incidents.map((incident) => {
        const firstLine = (incident.location_text ?? '').split('\n')[0].trim().toLowerCase();
        const zone = zoneByLabel.get(firstLine);
        return {
          id: incident.id,
          locationText: incident.location_text,
          type: incident.type,
          priority: incident.priority,
          status: incident.status,
          mapX: zone?.map_x ?? null,
          mapY: zone?.map_y ?? null,
        };
      });

      reply.send({ venueId, hasMapImage, zones, incidents: plotted });
    }
  );
}