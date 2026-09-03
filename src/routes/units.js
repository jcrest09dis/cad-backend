import { pool } from '../db/pool.js';
import { requireAuth, requireEventMembership, requireRole } from '../middleware/auth.js';
import { broadcastEventUpdate } from '../services/liveUpdates.js';

// Everything after ACK is field-staff-driven, not part of the
// Assignment/dispatch state machine. OUT_OF_SERVICE is an override that
// can be set at any time regardless of current assignment state.
// AVAILABLE was added later, specifically as the "return to service"
// path out of OUT_OF_SERVICE - the original design left it out
// entirely (AVAILABLE was meant to only be reached via completing/
// cancelling an assignment), which meant there was no way back once a
// unit went out of service. Gated below to only apply when there's no
// live assignment, so it can never conflict with the assignment
// lifecycle's own path to AVAILABLE.
const VALID_STATUSES = ['ENROUTE', 'ON_SCENE', 'TRANSPORTING', 'AT_DESTINATION', 'OUT_OF_SERVICE', 'AVAILABLE'];

export default async function unitRoutes(fastify) {
  fastify.post(
    '/events/:eventId/units/:id/status',
    { preHandler: [requireAuth, requireEventMembership, requireRole('field_staff', 'dispatcher')] },
    async (request, reply) => {
      const { status } = request.body;
      if (!VALID_STATUSES.includes(status)) {
        reply.code(400).send({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
        return;
      }

      // Field staff can only move a unit they actually crew - added while
      // building the field app, which surfaced that this wasn't enforced
      // before. Dispatchers can override any unit's status (matches their
      // existing broader authority elsewhere - e.g. cancelling assignments).
      if (request.eventRole === 'field_staff') {
        const { rows: crewCheck } = await pool.query(
          `SELECT 1 FROM unit_staff WHERE unit_id = $1 AND staff_id = $2`,
          [request.params.id, request.user.staffId]
        );
        if (crewCheck.length === 0) {
          reply.code(403).send({ error: 'not crewing this unit' });
          return;
        }
      }

      // A unit can only be moved past AVAILABLE if it has a live (ACKED)
      // assignment — except OUT_OF_SERVICE, which is a standalone override.
      if (status !== 'OUT_OF_SERVICE' && status !== 'AVAILABLE') {
        const { rows } = await pool.query(
          `SELECT a.status AS assignment_status
           FROM units u LEFT JOIN assignments a ON a.id = u.current_assignment_id
           WHERE u.id = $1`,
          [request.params.id]
        );
        if (rows.length === 0 || rows[0].assignment_status !== 'ACKED') {
          reply.code(409).send({ error: 'unit has no acknowledged assignment to progress' });
          return;
        }
      }

      // Setting AVAILABLE directly is only for returning from
      // OUT_OF_SERVICE (or correcting a stuck state) - never while a
      // live assignment still exists, or the unit would claim to be
      // available while actually tied to something. Complete or cancel
      // the assignment first in that case.
      if (status === 'AVAILABLE') {
        const { rows } = await pool.query(`SELECT current_assignment_id FROM units WHERE id = $1`, [
          request.params.id,
        ]);
        if (rows.length === 0) {
          reply.code(404).send({ error: 'unit not found' });
          return;
        }
        if (rows[0].current_assignment_id !== null) {
          reply.code(409).send({
            error: 'cannot mark available while a live assignment exists - complete or cancel it first',
          });
          return;
        }
      }

      await pool.query(`UPDATE units SET status = $1 WHERE id = $2`, [status, request.params.id]);
      broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: 'unit.status' });
      reply.send({ updated: true, status });
    }
  );

  fastify.get(
    '/events/:eventId/units',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT id, label, status, current_assignment_id FROM units WHERE event_id = $1 ORDER BY label`,
        [request.params.eventId]
      );
      reply.send(rows);
    }
  );
}
