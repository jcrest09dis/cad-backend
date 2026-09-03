import { pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';

/**
 * Creates an Assignment linking a Unit to an Incident, and atomically
 * queues the push notification via the outbox pattern (same transaction
 * as the assignment write, so a crash between "write assignment" and
 * "send push" can't silently drop the notification).
 *
 * The two partial unique indexes (one_active_assignment_per_unit,
 * one_active_assignment_per_incident) are what actually prevent the
 * double-booking race described in the design — this function just
 * has to handle the resulting unique_violation cleanly.
 */
export async function createAssignment({ incidentId, unitId, dispatcherId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const assignmentResult = await client.query(
      `INSERT INTO assignments (incident_id, unit_id, dispatcher_id, status)
       VALUES ($1, $2, $3, 'PENDING')
       RETURNING id`,
      [incidentId, unitId, dispatcherId]
    );
    const assignmentId = assignmentResult.rows[0].id;

    await client.query(
      `UPDATE units SET current_assignment_id = $1 WHERE id = $2`,
      [assignmentId, unitId]
    );

    await client.query(
      `UPDATE incidents SET status = 'DISPATCHED' WHERE id = $1 AND status = 'OPEN'`,
      [incidentId]
    );

    // Outbox: queue the push send in the same transaction as the assignment.
    await client.query(
      `INSERT INTO outbox_messages (assignment_id, channel, status, next_attempt_at)
       VALUES ($1, 'push', 'pending', now())`,
      [assignmentId]
    );

    await audit(client, {
      actorId: dispatcherId,
      action: 'assignment.create',
      entityType: 'assignment',
      entityId: assignmentId,
    });

    await client.query('COMMIT');
    return { assignmentId };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      // unique_violation on one of the partial indexes
      const err2 = new Error('unit or incident already has an active assignment');
      err2.statusCode = 409;
      throw err2;
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Idempotent ack: a retried push or a double-tap shouldn't error, just
 * no-op past the first successful ack.
 *
 * Only staff crewing the assignment's unit can ack it - added while
 * building the field app, which surfaced that this wasn't enforced
 * before (any field_staff at the event could ack any unit's assignment).
 */
export async function ackAssignment({ assignmentId, staffId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: crewCheck } = await client.query(
      `SELECT 1 FROM assignments a
       JOIN unit_staff us ON us.unit_id = a.unit_id
       WHERE a.id = $1 AND us.staff_id = $2`,
      [assignmentId, staffId]
    );
    if (crewCheck.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('not crewing this assignment\'s unit');
      err.statusCode = 403;
      throw err;
    }

    const { rows } = await client.query(
      `UPDATE assignments
       SET status = 'ACKED', acked_at = now()
       WHERE id = $1 AND status IN ('PENDING','ESCALATED_SMS')
       RETURNING id, status`,
      [assignmentId]
    );

    if (rows.length === 0) {
      // Already acked (or cancelled) — no-op, not an error.
      const existing = await client.query(`SELECT status FROM assignments WHERE id = $1`, [assignmentId]);
      await client.query('COMMIT');
      return { alreadyHandled: true, status: existing.rows[0]?.status };
    }

    await audit(client, {
      actorId: staffId,
      action: 'assignment.ack',
      entityType: 'assignment',
      entityId: assignmentId,
    });

    await client.query('COMMIT');
    return { alreadyHandled: false, status: 'ACKED' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dispatcher cancels an in-flight assignment. Must also stop any
 * pending outbox sends (SMS escalation) so a unit doesn't get an SMS
 * for an assignment that's already been reassigned.
 */
export async function cancelAssignment({ assignmentId, dispatcherId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE assignments
       SET status = 'CANCELLED'
       WHERE id = $1 AND status IN ('PENDING','ACKED','ESCALATED_SMS')
       RETURNING unit_id`,
      [assignmentId]
    );

    if (rows.length === 0) {
      const err = new Error('assignment not found or already terminal');
      err.statusCode = 409;
      throw err;
    }

    await client.query(
      `UPDATE units SET current_assignment_id = NULL, status = 'AVAILABLE'
       WHERE id = $1 AND current_assignment_id = $2`,
      [rows[0].unit_id, assignmentId]
    );

    // Cancel any not-yet-sent outbox messages (e.g. queued SMS escalation).
    await client.query(
      `UPDATE outbox_messages SET status = 'failed'
       WHERE assignment_id = $1 AND status = 'pending'`,
      [assignmentId]
    );

    await audit(client, {
      actorId: dispatcherId,
      action: 'assignment.cancel',
      entityType: 'assignment',
      entityId: assignmentId,
    });

    await client.query('COMMIT');
    return { cancelled: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dispatcher marks an assignment COMPLETED (typically once the unit's
 * own status has reached AT_DESTINATION), freeing the unit back to
 * AVAILABLE. Kept as an explicit dispatcher action rather than fully
 * automatic, since a dispatcher override is a real scenario.
 */
export async function completeAssignment({ assignmentId, dispatcherId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE assignments
       SET status = 'COMPLETED', resolved_at = now()
       WHERE id = $1 AND status = 'ACKED'
       RETURNING unit_id`,
      [assignmentId]
    );

    if (rows.length === 0) {
      const err = new Error('assignment not found or not in a completable state');
      err.statusCode = 409;
      throw err;
    }

    await client.query(
      `UPDATE units SET current_assignment_id = NULL, status = 'AVAILABLE'
       WHERE id = $1 AND current_assignment_id = $2`,
      [rows[0].unit_id, assignmentId]
    );

    await audit(client, {
      actorId: dispatcherId,
      action: 'assignment.complete',
      entityType: 'assignment',
      entityId: assignmentId,
    });

    await client.query('COMMIT');
    return { completed: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
