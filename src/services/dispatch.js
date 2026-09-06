import { pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { encryptNote } from '../lib/crypto.js';

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
 *
 * Accepts PENDING or UNCONFIRMED - a field device tapping Acknowledge
 * even after the escalation ladder already flagged it UNCONFIRMED is
 * still a real, valuable event (they were just late, not unreachable).
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
       SET status = 'ACKED', acked_at = now(), acked_by = $2, ack_method = 'self'
       WHERE id = $1 AND status IN ('PENDING','UNCONFIRMED')
       RETURNING id, status`,
      [assignmentId, staffId]
    );

    if (rows.length === 0) {
      // Already acked (or cancelled) — no-op, not an error.
      const existing = await client.query(`SELECT status FROM assignments WHERE id = $1`, [assignmentId]);
      await client.query('COMMIT');
      return { alreadyHandled: true, status: existing.rows[0]?.status };
    }

    // Stop any not-yet-sent push for this assignment - no need to keep
    // retrying once it's confirmed.
    await client.query(
      `UPDATE outbox_messages SET status = 'failed' WHERE assignment_id = $1 AND status = 'pending'`,
      [assignmentId]
    );

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
 * Dispatcher acknowledges an assignment on the unit's behalf - e.g.
 * confirmation came over the radio rather than through the app, and
 * the dispatcher shouldn't have to wait on a busy/on-scene unit to tap
 * their phone before progressing them through status updates. No crew
 * check (dispatchers aren't necessarily crew on any unit), and no role
 * restriction here since the route itself is dispatcher-gated.
 *
 * Recorded distinctly from a self-ack (ack_method = 'dispatcher_override')
 * - this is the dispatcher's assertion that contact was made, not proof
 * the field device itself received anything, and that distinction is
 * exactly what the escalation ladder exists to track.
 */
export async function dispatcherAckAssignment({ assignmentId, dispatcherId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE assignments
       SET status = 'ACKED', acked_at = now(), acked_by = $2, ack_method = 'dispatcher_override'
       WHERE id = $1 AND status IN ('PENDING','UNCONFIRMED')
       RETURNING id, status`,
      [assignmentId, dispatcherId]
    );

    if (rows.length === 0) {
      const existing = await client.query(`SELECT status FROM assignments WHERE id = $1`, [assignmentId]);
      await client.query('COMMIT');
      return { alreadyHandled: true, status: existing.rows[0]?.status };
    }

    await client.query(
      `UPDATE outbox_messages SET status = 'failed' WHERE assignment_id = $1 AND status = 'pending'`,
      [assignmentId]
    );

    await audit(client, {
      actorId: dispatcherId,
      action: 'assignment.ack.dispatcher_override',
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
 * A field unit dispatches themselves to an incident - no dispatcher
 * involved at all. Skips the whole push/ack handshake entirely (no
 * outbox row, no PENDING state) since a unit obviously doesn't need to
 * be notified of, or asked to acknowledge, their own action - it's
 * created directly as ACKED. dispatcher_id is set to the same staffId
 * as acked_by, since there genuinely isn't a separate dispatcher for
 * this assignment and the column is NOT NULL.
 *
 * Recorded with ack_method = 'self_initiated' - distinct from a normal
 * self-ack or a dispatcher's radio override, since this assignment was
 * never dispatched by anyone else in the first place.
 */
export async function selfDispatchAssignment({ incidentId, unitId, staffId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: crewCheck } = await client.query(
      `SELECT 1 FROM unit_staff WHERE unit_id = $1 AND staff_id = $2`,
      [unitId, staffId]
    );
    if (crewCheck.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('not crewing this unit');
      err.statusCode = 403;
      throw err;
    }

    const assignmentResult = await client.query(
      `INSERT INTO assignments (incident_id, unit_id, dispatcher_id, status, acked_at, acked_by, ack_method)
       VALUES ($1, $2, $3, 'ACKED', now(), $3, 'self_initiated')
       RETURNING id`,
      [incidentId, unitId, staffId]
    );
    const assignmentId = assignmentResult.rows[0].id;

    await client.query(`UPDATE units SET current_assignment_id = $1 WHERE id = $2`, [assignmentId, unitId]);
    await client.query(
      `UPDATE incidents SET status = 'DISPATCHED' WHERE id = $1 AND status = 'OPEN'`,
      [incidentId]
    );

    // Automatically log the self-dispatch as a real note, not just an
    // assignment record - shows up in the same note history everyone
    // already reads (live view, console, Reports), with author name and
    // timestamp handled for free by the existing note-revision display
    // (every revision already renders "authorName, timestamp" above its
    // content) - the note text itself only needs to say what happened,
    // not restate who/when.
    const { rows: unitRows } = await client.query(`SELECT label FROM units WHERE id = $1`, [unitId]);
    const unitLabel = unitRows[0]?.label ?? 'Unit';
    const noteContent = `Self-dispatched ${unitLabel} to this incident.`;
    const { ciphertext, keyId, dataKeyCiphertext } = await encryptNote(noteContent);

    await client.query(
      `UPDATE incidents SET notes_ciphertext = $1, notes_key_id = $2, notes_data_key_ciphertext = $3 WHERE id = $4`,
      [ciphertext, keyId, dataKeyCiphertext, incidentId]
    );
    await client.query(
      `INSERT INTO incident_note_revisions (incident_id, author_id, content_ciphertext, notes_key_id, data_key_ciphertext)
       VALUES ($1, $2, $3, $4, $5)`,
      [incidentId, staffId, ciphertext, keyId, dataKeyCiphertext]
    );
    await audit(client, {
      actorId: staffId,
      action: 'incident.notes.write',
      entityType: 'incident',
      entityId: incidentId,
    });

    await audit(client, {
      actorId: staffId,
      action: 'assignment.self_dispatch',
      entityType: 'assignment',
      entityId: assignmentId,
    });

    await client.query('COMMIT');
    return { assignmentId };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      // Same partial unique indexes that protect dispatcher-created
      // assignments - this unit or incident already has a live one.
      const err2 = new Error('this unit or incident already has an active assignment');
      err2.statusCode = 409;
      throw err2;
    }
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
