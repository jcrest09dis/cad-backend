import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Self-service "what am I staffed on right now" endpoint. Needed because
 * every other route assumes the caller already knows an eventId - but a
 * dispatcher logging in has no way to discover that without this.
 */
export default async function meRoutes(fastify) {
  fastify.get('/me/events', { preHandler: [requireAuth] }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.status, e.start_time, v.name AS venue_name, es.role_for_event
       FROM event_staffing es
       JOIN events e ON e.id = es.event_id
       JOIN venues v ON v.id = e.venue_id
       WHERE es.staff_id = $1 AND es.checked_out_at IS NULL
       ORDER BY e.start_time DESC`,
      [request.user.staffId]
    );
    reply.send(rows);
  });

  fastify.get('/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.role, s.is_admin,
              EXISTS (
                SELECT 1 FROM event_staffing
                WHERE staff_id = s.id AND role_for_event = 'dispatcher'
              ) AS has_dispatched
       FROM staff s WHERE s.id = $1`,
      [request.user.staffId]
    );
    const row = rows[0];
    if (!row) {
      reply.send({});
      return;
    }
    // canViewReports mirrors requireReportingAccess exactly - computed
    // here so the console doesn't need to reimplement the same rule.
    reply.send({
      id: row.id,
      name: row.name,
      role: row.role,
      is_admin: row.is_admin,
      canViewReports: row.is_admin || row.has_dispatched,
    });
  });

  // Discoverable list of active events, for self-check-in - deliberately
  // not scoped by venue/roster, since staff are pooled across events (see
  // design discussion). Anyone with a valid login can see any active event.
  fastify.get('/events', { preHandler: [requireAuth] }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.start_time, v.name AS venue_name
       FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.status = 'active'
       ORDER BY e.start_time`
    );
    reply.send(rows);
  });

  // Self-check-in. Deliberately can only ever grant 'field_staff' on
  // first check-in - staff can't self-elevate to dispatcher/admin, that
  // still requires an admin via POST /admin/events/:eventId/staffing.
  // Re-checking in after a prior checkout preserves whatever role they
  // already had (so a promoted dispatcher doesn't get silently demoted).
  fastify.post('/me/events/:eventId/checkin', { preHandler: [requireAuth] }, async (request, reply) => {
    const { rows } = await pool.query(
      `INSERT INTO event_staffing (event_id, staff_id, role_for_event, checked_in_at)
       VALUES ($1, $2, 'field_staff', now())
       ON CONFLICT (event_id, staff_id)
       DO UPDATE SET checked_in_at = now(), checked_out_at = NULL
       RETURNING id, role_for_event`,
      [request.params.eventId, request.user.staffId]
    );
    reply.send(rows[0]);
  });

  fastify.post('/me/events/:eventId/checkout', { preHandler: [requireAuth] }, async (request, reply) => {
    await pool.query(
      `UPDATE event_staffing SET checked_out_at = now()
       WHERE event_id = $1 AND staff_id = $2`,
      [request.params.eventId, request.user.staffId]
    );
    reply.send({ checkedOut: true });
  });

  // The field app's home screen: which unit(s) am I crewing at this event,
  // and what's their current assignment (if any) plus the incident it's
  // for. One query instead of the app stitching together units + crew +
  // assignments + incidents itself.
  fastify.get('/me/events/:eventId/units', { preHandler: [requireAuth] }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.label, u.status,
              a.id AS assignment_id, a.status AS assignment_status,
              i.id AS incident_id, i.type AS incident_type, i.priority AS incident_priority,
              COALESCE(i.location_text, vz.label) AS zone_label
       FROM unit_staff us
       JOIN units u ON u.id = us.unit_id
       LEFT JOIN assignments a ON a.id = u.current_assignment_id
       LEFT JOIN incidents i ON i.id = a.incident_id
       LEFT JOIN venue_zones vz ON vz.id = i.location_zone_id
       WHERE us.staff_id = $1 AND u.event_id = $2`,
      [request.user.staffId, request.params.eventId]
    );
    reply.send(rows);
  });

  // Saves the device's push token so the outbox worker can actually reach
  // it. Provider-agnostic on purpose (works whether PUSH_PROVIDER is the
  // stub, Expo, or a real APNs/FCM integration later) - it's just a string.
  fastify.post('/me/push-token', { preHandler: [requireAuth] }, async (request, reply) => {
    const { token } = request.body;
    await pool.query(`UPDATE staff SET device_push_token = $1 WHERE id = $2`, [token, request.user.staffId]);
    reply.send({ saved: true });
  });
}
