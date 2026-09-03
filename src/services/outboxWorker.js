import { pool } from '../db/pool.js';
import { sendPush } from './push.js';

const POLL_INTERVAL_MS = 5000;
const MAX_ATTEMPTS = 5;

/**
 * Polls outbox_messages for pending sends and dispatches them. Push
 * only now - SMS was removed as an escalation channel (see
 * escalationWorker.js for why). Historical 'sms' rows from before that
 * change would already be resolved (sent/failed) by now; if any somehow
 * remain pending, this worker simply won't match them (no channel
 * branch for 'sms' anymore) and they'll age out via the outbox's own
 * logic rather than error.
 * At this scale (a handful of events, dozens of assignments/night) a
 * simple poll every few seconds is plenty — no need for a stream
 * processor.
 */
export function startOutboxWorker() {
  const interval = setInterval(() => {
    // processOnce is async; setInterval doesn't await it or catch its
    // rejections, and Node terminates the whole process on an unhandled
    // rejection by default (this is exactly what just happened - a SQL
    // bug here took down live dispatch for the entire event, not just
    // failed one send). A background worker must never be able to crash
    // the process outright, so every future error here - known or not -
    // is now caught and logged instead of propagating.
    processOnce().catch((err) => {
      console.error('[outbox] processOnce failed unexpectedly:', err);
    });
  }, POLL_INTERVAL_MS);
  return () => clearInterval(interval);
}

export async function processOnce() {
  const { rows } = await pool.query(
    `SELECT om.id, om.assignment_id, om.channel, om.attempts,
            a.unit_id, i.type AS incident_type, i.priority,
            COALESCE(i.location_text, vz.label) AS zone_label
     FROM outbox_messages om
     JOIN assignments a ON a.id = om.assignment_id
     JOIN incidents i ON i.id = a.incident_id
     LEFT JOIN venue_zones vz ON vz.id = i.location_zone_id
     WHERE om.status = 'pending' AND om.next_attempt_at <= now()
     ORDER BY om.next_attempt_at
     LIMIT 20`
  );

  for (const row of rows) {
    try {
      // A unit can be crewed by more than one staff member; message goes to all of them.
      const { rows: crew } = await pool.query(
        `SELECT s.id, s.device_push_token, s.phone
         FROM unit_staff us JOIN staff s ON s.id = us.staff_id
         WHERE us.unit_id = $1`,
        [row.unit_id]
      );

      // Each recipient's send is independent - one crew member having
      // a missing/bad phone number (or an unreachable device) must not
      // block delivery to everyone else on the same unit. This is a
      // safety-critical escalation channel; better to occasionally
      // retry-and-duplicate a message to someone who already got it
      // than to let one bad phone number silently block everyone.
      const sendErrors = [];
      for (const person of crew) {
        try {
          if (row.channel === 'push') {
            await sendPush({
              deviceToken: person.device_push_token,
              assignmentId: row.assignment_id,
              incidentType: row.incident_type,
              zoneLabel: row.zone_label,
              priority: row.priority,
            });
          }
        } catch (err) {
          sendErrors.push(`${person.id}: ${err.message}`);
        }
      }
      if (sendErrors.length > 0) {
        throw new Error(sendErrors.join('; '));
      }
      await pool.query(`UPDATE outbox_messages SET status = 'sent' WHERE id = $1`, [row.id]);
    } catch (err) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      try {
        await pool.query(
          `UPDATE outbox_messages
           SET attempts = $1,
               status = $2,
               next_attempt_at = now() + (interval '10 seconds' * $1::integer)
           WHERE id = $3`,
          [attempts, failed ? 'failed' : 'pending', row.id]
        );
      } catch (bookkeepingErr) {
        // Even the retry-scheduling update failing shouldn't abort the
        // rest of this batch - log both errors and move on to the next
        // row rather than let one bad row block everything else pending.
        console.error(`[outbox] retry bookkeeping failed for ${row.id}:`, bookkeepingErr.message);
      }
      console.error(`[outbox] send failed for ${row.id} (attempt ${attempts}):`, err.message);
    }
  }
}
