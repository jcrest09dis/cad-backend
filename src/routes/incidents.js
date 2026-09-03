import { pool } from '../db/pool.js';
import { requireAuth, requireEventMembership, requireRole } from '../middleware/auth.js';
import { encryptNote, decryptNote } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { broadcastEventUpdate } from '../services/liveUpdates.js';

// Field staff can still edit notes through OPEN and DISPATCHED; locked
// once the incident reaches a terminal status (RESOLVED/CANCELLED).
const FIELD_STAFF_EDITABLE_STATUSES = ['OPEN', 'DISPATCHED'];

export default async function incidentRoutes(fastify) {
  // Zone list for the event's venue. No longer used for a required
  // location dropdown on incident creation - location is free text now
  // (see POST /events/:eventId/incidents) - kept for admin zone
  // management (AdminVenuesTab) and any future typeahead/suggestions.
  fastify.get(
    '/events/:eventId/zones',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT vz.id, vz.label
         FROM venue_zones vz
         JOIN events e ON e.venue_id = vz.venue_id
         WHERE e.id = $1
         ORDER BY vz.label`,
        [request.params.eventId]
      );
      reply.send(rows);
    }
  );

  fastify.post(
    '/events/:eventId/incidents',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const { locationText, type, priority } = request.body;
      if (!locationText || !locationText.trim()) {
        reply.code(400).send({ error: 'locationText is required' });
        return;
      }
      const { rows } = await pool.query(
        `INSERT INTO incidents (event_id, location_text, type, priority, status, created_by)
         VALUES ($1, $2, $3, $4, 'OPEN', $5)
         RETURNING id`,
        [request.params.eventId, locationText.trim(), type, priority ?? 'medium', request.user.staffId]
      );
      broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: 'incident.created' });
      reply.code(201).send({ incidentId: rows[0].id });
    }
  );

    // Dispatcher resolves/cancels an incident. Uses the same row lock
  // (FOR UPDATE) as the notes-write path so a field-staff edit racing
  // this status change resolves cleanly instead of silently succeeding
  // into an incident that's supposed to be closed.
  //
  // Also resolves the "orphaned assignment" trap discovered while testing
  // the field app: resolving/cancelling an incident used to leave its
  // Assignment (and the Unit tied to it) stranded if nobody had separately
  // completed/cancelled the assignment first - the incident would vanish
  // from the open-incidents list with no way back to it, and the unit
  // would stay stuck unavailable. Now the incident and its assignment
  // move together, in the same transaction:
  //   RESOLVED + assignment ACKED       -> assignment COMPLETED (delivered)
  //   RESOLVED + assignment not yet ACKED -> assignment CANCELLED (never happened)
  //   CANCELLED + any live assignment   -> assignment CANCELLED
  // Either way the unit is freed back to AVAILABLE as part of the same
  // update, not left dangling.
  fastify.post(
    '/events/:eventId/incidents/:id/status',
    { preHandler: [requireAuth, requireEventMembership, requireRole('dispatcher')] },
    async (request, reply) => {
      const { status } = request.body;
      if (!['RESOLVED', 'CANCELLED'].includes(status)) {
        reply.code(400).send({ error: 'status must be RESOLVED or CANCELLED' });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT id FROM incidents WHERE id = $1 FOR UPDATE`, [request.params.id]);
        const { rows } = await client.query(
          `UPDATE incidents SET status = $1, closed_at = now() WHERE id = $2 RETURNING id`,
          [status, request.params.id]
        );
        if (rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404).send({ error: 'incident not found' });
          return;
        }

        const { rows: liveAssignments } = await client.query(
          `SELECT id, unit_id, status FROM assignments
           WHERE incident_id = $1 AND status IN ('PENDING','ACKED','ESCALATED_SMS','UNCONFIRMED')`,
          [request.params.id]
        );

        for (const assignment of liveAssignments) {
          const resolveAsCompleted = status === 'RESOLVED' && assignment.status === 'ACKED';
          const newAssignmentStatus = resolveAsCompleted ? 'COMPLETED' : 'CANCELLED';

          await client.query(
            `UPDATE assignments SET status = $1, resolved_at = now() WHERE id = $2`,
            [newAssignmentStatus, assignment.id]
          );
          await client.query(
            `UPDATE units SET current_assignment_id = NULL, status = 'AVAILABLE'
             WHERE id = $1 AND current_assignment_id = $2`,
            [assignment.unit_id, assignment.id]
          );
          if (newAssignmentStatus === 'CANCELLED') {
            // Same as the manual cancel path (dispatch.js cancelAssignment) -
            // stop any not-yet-sent SMS escalation for an assignment that's
            // now closed, so the unit doesn't get a stale text.
            await client.query(
              `UPDATE outbox_messages SET status = 'failed'
               WHERE assignment_id = $1 AND status = 'pending'`,
              [assignment.id]
            );
          }
          await audit(client, {
            actorId: request.user.staffId,
            action: `assignment.${newAssignmentStatus.toLowerCase()}.via_incident_${status.toLowerCase()}`,
            entityType: 'assignment',
            entityId: assignment.id,
          });
        }

        await audit(client, {
          actorId: request.user.staffId,
          action: `incident.status.${status.toLowerCase()}`,
          entityType: 'incident',
          entityId: request.params.id,
        });
        await client.query('COMMIT');
        broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: `incident.${status.toLowerCase()}` });
        reply.send({ updated: true, status });
      } catch (err) {
        await client.query('ROLLBACK');
        reply.code(500).send({ error: err.message });
      } finally {
        client.release();
      }
    }
  );

  // Field staff: all OPEN/DISPATCHED incidents at their currently-checked-in
  // event (situational awareness / collaboration). Dispatcher: everything.
  fastify.get(
    '/events/:eventId/incidents',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const isDispatcher = request.eventRole === 'dispatcher';
      const { rows } = await pool.query(
        `SELECT i.id, i.location_zone_id, COALESCE(i.location_text, vz.label) AS zone_label,
                i.type, i.priority, i.status, i.created_by, i.created_at
         FROM incidents i
         LEFT JOIN venue_zones vz ON vz.id = i.location_zone_id
         WHERE i.event_id = $1 ${isDispatcher ? '' : "AND i.status IN ('OPEN','DISPATCHED')"}
         ORDER BY i.created_at DESC`,
        [request.params.eventId]
      );
      reply.send(rows);
    }
  );

  // Read notes - now the full revision history, not just current text
  // (matches the reporting view; the person asked for consistency
  // between the two). Logged to audit_log on every call - HIPAA cares
  // about who viewed PHI, not just who changed it. RBAC is unchanged -
  // who can reach this endpoint at all is still governed by
  // requireEventMembership below, same as before; only what's returned
  // once you're allowed to look expanded to full history.
  fastify.get(
    '/events/:eventId/incidents/:id/notes',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT id FROM incidents WHERE id = $1 AND event_id = $2`,
        [request.params.id, request.params.eventId]
      );
      if (rows.length === 0) {
        reply.code(404).send({ error: 'incident not found' });
        return;
      }

      const { rows: revisionRows } = await pool.query(
        `SELECT r.id, r.content_ciphertext, r.notes_key_id, r.data_key_ciphertext,
                r.created_at, s.name AS author_name
         FROM incident_note_revisions r
         JOIN staff s ON s.id = r.author_id
         WHERE r.incident_id = $1
         ORDER BY r.created_at`,
        [request.params.id]
      );

      const revisions = await Promise.all(
        revisionRows.map(async (r) => {
          let content;
          try {
            content = await decryptNote(r.content_ciphertext, r.notes_key_id, r.data_key_ciphertext);
          } catch (err) {
            request.log.error({ err, revisionId: r.id }, 'Note revision decrypt failed');
            content = '[unable to decrypt this revision - encryption key may have changed]';
          }
          return { id: r.id, authorName: r.author_name, createdAt: r.created_at, content };
        })
      );

      if (revisionRows.length > 0) {
        await audit(null, {
          actorId: request.user.staffId,
          action: 'incident.notes.read',
          entityType: 'incident',
          entityId: request.params.id,
        });
      }

      // notes = current text, kept for any caller still expecting the
      // old shape; revisions = full history, newest last (chronological,
      // matching the reporting view's order).
      reply.send({
        notes: revisions.length > 0 ? revisions[revisions.length - 1].content : null,
        revisions,
      });
    }
  );

  // Add/edit notes. Field staff: only on their own current assignment's
  // incident, and only while status is OPEN/DISPATCHED. Dispatcher:
  // any incident on the event, any status.
  fastify.post(
    '/events/:eventId/incidents/:id/notes',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const { content } = request.body;
      const incidentId = request.params.id;
      const staffId = request.user.staffId;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(
          `SELECT status FROM incidents WHERE id = $1 AND event_id = $2 FOR UPDATE`,
          [incidentId, request.params.eventId]
        );
        if (rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404).send({ error: 'incident not found' });
          return;
        }
        const { status } = rows[0];

        if (request.eventRole === 'field_staff') {
          if (!FIELD_STAFF_EDITABLE_STATUSES.includes(status)) {
            await client.query('ROLLBACK');
            reply.code(403).send({ error: 'incident is closed; notes are locked for field staff' });
            return;
          }

          // Must be tied to the field staffer's own current assignment.
          const { rows: ownAssignment } = await client.query(
            `SELECT a.id FROM assignments a
             JOIN unit_staff us ON us.unit_id = a.unit_id
             WHERE a.incident_id = $1 AND us.staff_id = $2
               AND a.status IN ('PENDING','ACKED','ESCALATED_SMS')`,
            [incidentId, staffId]
          );
          if (ownAssignment.length === 0) {
            await client.query('ROLLBACK');
            reply.code(403).send({ error: 'not assigned to this incident' });
            return;
          }
        } else if (request.eventRole !== 'dispatcher') {
          await client.query('ROLLBACK');
          reply.code(403).send({ error: 'not permitted to write notes' });
          return;
        }

        const { ciphertext, keyId, dataKeyCiphertext } = await encryptNote(content);

        await client.query(
          `UPDATE incidents SET notes_ciphertext = $1, notes_key_id = $2, notes_data_key_ciphertext = $3
           WHERE id = $4`,
          [ciphertext, keyId, dataKeyCiphertext, incidentId]
        );
        await client.query(
          `INSERT INTO incident_note_revisions
             (incident_id, author_id, content_ciphertext, notes_key_id, data_key_ciphertext)
           VALUES ($1, $2, $3, $4, $5)`,
          [incidentId, staffId, ciphertext, keyId, dataKeyCiphertext]
        );
        await audit(client, {
          actorId: staffId,
          action: 'incident.notes.write',
          entityType: 'incident',
          entityId: incidentId,
        });

        await client.query('COMMIT');
        reply.send({ updated: true });
      } catch (err) {
        await client.query('ROLLBACK');
        reply.code(500).send({ error: err.message });
      } finally {
        client.release();
      }
    }
  );
}
