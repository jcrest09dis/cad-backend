import { pool } from '../db/pool.js';
import { broadcastEventUpdate } from './liveUpdates.js';

/**
 * Closing an event does real cleanup, not just a status flip:
 *  - any unit still belonging to this event returns to the pool
 *    (event_id = NULL, matching the pooled-unit model), reset to
 *    AVAILABLE, with its current_assignment_id cleared
 *  - any assignment still active at close time (PENDING/ACKED/
 *    UNCONFIRMED) is cancelled first - otherwise it'd be left
 *    dangling, referencing a unit that just got yanked out of the
 *    event and a status that no longer means anything once the event
 *    is over
 *  - crew (unit_staff) is cleared for those units - crewing was
 *    contextual to this event, and since the unit itself is returning
 *    to the pool for reuse elsewhere, carrying the old crew forward
 *    to whatever event picks it up next wouldn't make sense. Not a
 *    historical record the way EventStaffing is, so deleting it here
 *    loses nothing worth keeping.
 *  - every staff member still checked in is checked OUT
 *    (checked_out_at = now()), not deleted - EventStaffing is the
 *    actual historical "who worked this event" record, and this
 *    project has consistently preferred checking out over deleting
 *    for exactly that reason (see staff deactivation vs. hard delete).
 *
 * Shared by both the admin-only close route and the dispatcher-facing
 * one on the live dashboard - same real consequences either way, so
 * the logic lives in one place rather than two copies drifting apart.
 */
export async function closeEvent({ eventId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`UPDATE events SET status = 'closed' WHERE id = $1`, [eventId]);

    const { rows: unitRows } = await client.query(`SELECT id FROM units WHERE event_id = $1`, [eventId]);

    for (const unit of unitRows) {
      await client.query(
        `UPDATE assignments SET status = 'CANCELLED'
         WHERE unit_id = $1 AND status IN ('PENDING','ACKED','UNCONFIRMED')`,
        [unit.id]
      );
      await client.query(`DELETE FROM unit_staff WHERE unit_id = $1`, [unit.id]);
      await client.query(
        `UPDATE units SET event_id = NULL, current_assignment_id = NULL, status = 'AVAILABLE' WHERE id = $1`,
        [unit.id]
      );
    }

    const { rows: checkedOutStaff } = await client.query(
      `UPDATE event_staffing SET checked_out_at = now()
       WHERE event_id = $1 AND checked_out_at IS NULL
       RETURNING id`,
      [eventId]
    );

    await client.query('COMMIT');
    broadcastEventUpdate(eventId, { type: 'refresh', reason: 'event.closed' });
    return { closed: true, unitsUnassigned: unitRows.length, staffCheckedOut: checkedOutStaff.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
