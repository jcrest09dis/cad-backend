import { pool } from '../db/pool.js';
import { requireAuth, requireEventMembership, requireRole } from '../middleware/auth.js';
import {
  createAssignment,
  ackAssignment,
  dispatcherAckAssignment,
  cancelAssignment,
  completeAssignment,
} from '../services/dispatch.js';
import { broadcastEventUpdate } from '../services/liveUpdates.js';

export default async function assignmentRoutes(fastify) {
  // List active (non-terminal) assignments for the event - the console
  // needs this to know which unit is on which incident, and to show
  // escalation state (PENDING/ACKED/UNCONFIRMED). acked_by_name/ack_method
  // let the UI show *how* an assignment was confirmed (the unit's own
  // device, or a dispatcher recording radio confirmation) - see
  // dispatcherAckAssignment for why that distinction matters.
  fastify.get(
    '/events/:eventId/assignments',
    { preHandler: [requireAuth, requireEventMembership] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT a.id, a.incident_id, a.unit_id, a.status, a.escalation_stage,
                a.created_at, a.acked_at, a.ack_method, s.name AS acked_by_name
         FROM assignments a
         JOIN incidents i ON i.id = a.incident_id
         LEFT JOIN staff s ON s.id = a.acked_by
         WHERE i.event_id = $1 AND a.status NOT IN ('CANCELLED','COMPLETED')`,
        [request.params.eventId]
      );
      reply.send(rows);
    }
  );

  // Dispatcher creates an assignment (dispatch a unit to an incident).
  fastify.post(
    '/events/:eventId/assignments',
    { preHandler: [requireAuth, requireEventMembership, requireRole('dispatcher')] },
    async (request, reply) => {
      const { incidentId, unitId } = request.body;
      try {
        const result = await createAssignment({
          incidentId,
          unitId,
          dispatcherId: request.user.staffId,
        });
        broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: 'assignment.created' });
        reply.code(201).send(result);
      } catch (err) {
        reply.code(err.statusCode ?? 500).send({ error: err.message });
      }
    }
  );

  // Field staff acknowledges an assignment. Idempotent - safe to retry.
  fastify.post(
    '/events/:eventId/assignments/:id/ack',
    { preHandler: [requireAuth, requireEventMembership, requireRole('field_staff')] },
    async (request, reply) => {
      try {
        const result = await ackAssignment({
          assignmentId: request.params.id,
          staffId: request.user.staffId,
        });
        broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: 'assignment.acked' });
        reply.send(result);
      } catch (err) {
        reply.code(err.statusCode ?? 500).send({ error: err.message });
      }
    }
  );

  // Dispatcher acknowledges on the unit's behalf (e.g. confirmed over
  // the radio) - lets the unit progress through status updates without
  // waiting on them to tap Acknowledge in the app themselves, which
  // matters when they're busy or already with a patient. Recorded
  // distinctly from a self-ack - see dispatcherAckAssignment.
  fastify.post(
    '/events/:eventId/assignments/:id/dispatcher-ack',
    { preHandler: [requireAuth, requireEventMembership, requireRole('dispatcher')] },
    async (request, reply) => {
      try {
        const result = await dispatcherAckAssignment({
          assignmentId: request.params.id,
          dispatcherId: request.user.staffId,
        });
        broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: 'assignment.acked' });
        reply.send(result);
      } catch (err) {
        reply.code(err.statusCode ?? 500).send({ error: err.message });
      }
    }
  );

  fastify.post(
    '/events/:eventId/assignments/:id/cancel',
    { preHandler: [requireAuth, requireEventMembership, requireRole('dispatcher')] },
    async (request, reply) => {
      try {
        const result = await cancelAssignment({
          assignmentId: request.params.id,
          dispatcherId: request.user.staffId,
        });
        broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: 'assignment.cancelled' });
        reply.send(result);
      } catch (err) {
        reply.code(err.statusCode ?? 500).send({ error: err.message });
      }
    }
  );

  fastify.post(
    '/events/:eventId/assignments/:id/complete',
    { preHandler: [requireAuth, requireEventMembership, requireRole('dispatcher')] },
    async (request, reply) => {
      try {
        const result = await completeAssignment({
          assignmentId: request.params.id,
          dispatcherId: request.user.staffId,
        });
        broadcastEventUpdate(request.params.eventId, { type: 'refresh', reason: 'assignment.completed' });
        reply.send(result);
      } catch (err) {
        reply.code(err.statusCode ?? 500).send({ error: err.message });
      }
    }
  );
}