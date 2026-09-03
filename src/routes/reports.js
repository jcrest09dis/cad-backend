import { pool } from '../db/pool.js';
import { requireAuth, requireReportingAccess } from '../middleware/auth.js';
import { decryptNote } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';

/**
 * Incident history/reporting - deliberately separate from the live
 * dispatch endpoints (routes/incidents.js), which are scoped to "your
 * currently checked-in event" via requireEventMembership. This spans
 * past events on purpose - see requireReportingAccess in
 * middleware/auth.js for who gets it and why.
 */
export default async function reportRoutes(fastify) {
  // Event filter dropdown needs every event, including closed ones - the
  // existing /events (active-only, for self-check-in) and /admin/events
  // (admin-gated) don't fit here, since reporting access is broader than
  // admin-only but narrower than "every active event."
  fastify.get(
    '/reports/events',
    { preHandler: [requireAuth, requireReportingAccess] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT e.id, e.name, e.status, v.name AS venue_name
         FROM events e JOIN venues v ON v.id = e.venue_id
         ORDER BY e.start_time DESC`
      );
      reply.send(rows);
    }
  );

  fastify.get(
    '/reports/incidents',
    { preHandler: [requireAuth, requireReportingAccess] },
    async (request, reply) => {
      const { eventId, from, to, type, priority, status } = request.query;

      const conditions = [];
      const params = [];

      function addFilter(sql, value) {
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
      }

      if (eventId) addFilter('i.event_id = ?', eventId);
      if (from) addFilter('i.created_at >= ?', from);
      if (to) addFilter('i.created_at <= ?', to);
      if (type) addFilter('i.type = ?', type);
      if (priority) addFilter('i.priority = ?', priority);
      if (status) addFilter('i.status = ?', status);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `SELECT i.id, i.event_id, e.name AS event_name, v.name AS venue_name,
                COALESCE(i.location_text, vz.label) AS zone_label, i.type, i.priority, i.status,
                i.created_at, i.closed_at,
                (SELECT array_agg(DISTINCT u.label)
                 FROM assignments a JOIN units u ON u.id = a.unit_id
                 WHERE a.incident_id = i.id) AS unit_labels
         FROM incidents i
         JOIN events e ON e.id = i.event_id
         JOIN venues v ON v.id = e.venue_id
         LEFT JOIN venue_zones vz ON vz.id = i.location_zone_id
         ${whereClause}
         ORDER BY i.created_at DESC
         LIMIT 200`,
        params
      );
      reply.send(rows);
    }
  );

  fastify.get(
    '/reports/incidents/:id',
    { preHandler: [requireAuth, requireReportingAccess] },
    async (request, reply) => {
      const incidentId = request.params.id;

      const { rows: incidentRows } = await pool.query(
        `SELECT i.id, i.event_id, e.name AS event_name, v.name AS venue_name,
                COALESCE(i.location_text, vz.label) AS zone_label, i.type, i.priority, i.status,
                i.created_at, i.closed_at, s.name AS created_by_name
         FROM incidents i
         JOIN events e ON e.id = i.event_id
         JOIN venues v ON v.id = e.venue_id
         LEFT JOIN venue_zones vz ON vz.id = i.location_zone_id
         JOIN staff s ON s.id = i.created_by
         WHERE i.id = $1`,
        [incidentId]
      );
      if (incidentRows.length === 0) {
        reply.code(404).send({ error: 'incident not found' });
        return;
      }

      const { rows: assignmentRows } = await pool.query(
        `SELECT a.id, a.status, a.created_at, a.acked_at, a.resolved_at,
                u.label AS unit_label, s.name AS dispatcher_name
         FROM assignments a
         JOIN units u ON u.id = a.unit_id
         JOIN staff s ON s.id = a.dispatcher_id
         WHERE a.incident_id = $1
         ORDER BY a.created_at`,
        [incidentId]
      );

      const { rows: revisionRows } = await pool.query(
        `SELECT r.id, r.content_ciphertext, r.notes_key_id, r.data_key_ciphertext,
                r.created_at, s.name AS author_name
         FROM incident_note_revisions r
         JOIN staff s ON s.id = r.author_id
         WHERE r.incident_id = $1
         ORDER BY r.created_at`,
        [incidentId]
      );

      let noteRevisions = [];
      if (revisionRows.length > 0) {
        noteRevisions = await Promise.all(
          revisionRows.map(async (r) => {
            let content;
            try {
              content = await decryptNote(r.content_ciphertext, r.notes_key_id, r.data_key_ciphertext);
            } catch (err) {
              // Same failure mode as a rotated/lost encryption key - don't
              // let one bad revision take down the whole report, just
              // flag that one entry.
              request.log.error({ err, revisionId: r.id }, 'Note revision decrypt failed');
              content = '[unable to decrypt this revision - encryption key may have changed]';
            }
            return {
              id: r.id,
              authorName: r.author_name,
              createdAt: r.created_at,
              content,
            };
          })
        );

        // One audit entry for viewing the notes history, not one per
        // revision - same "every read gets logged" requirement as the
        // live notes endpoint, without spamming N rows for N revisions
        // in a single view.
        await audit(null, {
          actorId: request.user.staffId,
          action: 'incident.notes.read.history',
          entityType: 'incident',
          entityId: incidentId,
        });
      }

      reply.send({
        ...incidentRows[0],
        assignments: assignmentRows,
        noteRevisions,
      });
    }
  );
}
