import { pool } from '../db/pool.js';

/**
 * Auth/RBAC model, per the whiteboarded PHI boundary:
 *
 *  - Field staff: read all OPEN/DISPATCHED incidents at the venue/event
 *    they're currently checked into. Write notes only on incidents tied
 *    to their own current Assignment. Edit only while Incident.status
 *    is OPEN or DISPATCHED (locked at RESOLVED/CANCELLED).
 *  - Dispatcher: full read/edit on incident notes for events they're
 *    dispatching, at any status.
 *  - Admin: manages Staff/Unit/VenueZone records. Does NOT get default
 *    PHI access — admin and PHI-access are separate roles.
 *
 * This assumes a JWT already verified upstream (@fastify/jwt) populating
 * request.user = { staffId }. Role is not baked into the JWT because the
 * same staff member's role can differ per event (EventStaffing.role_for_event),
 * so we look it up per-request against the event in the URL.
 */

export async function requireAuth(request, reply) {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'unauthorized' });
  }
}

/**
 * Loads the caller's role for the event referenced in the route params
 * (expects request.params.eventId) and attaches it as request.eventRole.
 * Rejects if the staff member isn't currently checked in to that event.
 */
export async function requireEventMembership(request, reply) {
  const { eventId } = request.params;
  const staffId = request.user.staffId;

  const { rows } = await pool.query(
    `SELECT role_for_event FROM event_staffing
     WHERE event_id = $1 AND staff_id = $2 AND checked_out_at IS NULL`,
    [eventId, staffId]
  );

  if (rows.length === 0) {
    reply.code(403).send({ error: 'not checked in to this event' });
    return;
  }

  request.eventRole = rows[0].role_for_event; // 'field_staff' | 'dispatcher' | 'admin'
}

export function requireRole(...allowedRoles) {
  return async function (request, reply) {
    if (!allowedRoles.includes(request.eventRole)) {
      reply.code(403).send({ error: `requires role: ${allowedRoles.join(' or ')}` });
    }
  };
}

/**
 * Gates org-level admin endpoints (creating staff, venues, events, units -
 * things that exist before any event-scoped role can apply) behind a
 * real staff.is_admin flag, checked against the caller's own JWT.
 * Replaces the old shared-secret bootstrap mechanism entirely - see
 * server.js for how the very first admin gets that flag set without any
 * HTTP-exposed secret.
 */
export async function requireGlobalAdmin(request, reply) {
  const { rows } = await pool.query(`SELECT is_admin FROM staff WHERE id = $1`, [request.user.staffId]);
  if (rows.length === 0 || !rows[0].is_admin) {
    reply.code(403).send({ error: 'requires admin' });
  }
}

/**
 * Gates the incident history/reporting endpoints. Broader than
 * requireEventMembership on purpose - reporting is meant to span past
 * events, not just the one currently in the URL, so "checked in right
 * now" isn't the right test. Access is granted to admins, plus anyone
 * who has ever held the dispatcher role for at least one event
 * (regardless of whether they're currently checked into anything) -
 * being a dispatcher at all is treated as ongoing trust for reviewing
 * incident history, not something that expires when a shift ends.
 */
export async function requireReportingAccess(request, reply) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT is_admin FROM staff WHERE id = $1) AS is_admin,
       EXISTS (
         SELECT 1 FROM event_staffing
         WHERE staff_id = $1 AND role_for_event = 'dispatcher'
       ) AS has_dispatched`,
    [request.user.staffId]
  );
  const { is_admin, has_dispatched } = rows[0] ?? {};
  if (!is_admin && !has_dispatched) {
    reply.code(403).send({ error: 'requires admin or dispatcher history' });
  }
}
