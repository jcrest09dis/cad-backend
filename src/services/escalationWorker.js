import { pool } from '../db/pool.js';
import { broadcastEventUpdate } from './liveUpdates.js';

const POLL_INTERVAL_MS = 5000;

// Stage 0: just created (push already queued by createAssignment)
// Stage 1: resend push
// Stage 2: flag UNCONFIRMED for the dispatcher console — system stops
//          trying to be clever, hands off to a human.
//
// SMS was removed as a middle stage after Twilio trial-account
// restrictions made it a dead end for this project (trial accounts can
// only send from a small set of Twilio-predefined canned templates, not
// custom content like an incident's actual type/zone/priority - see the
// README). Historical assignments from before this change may still
// show ESCALATED_SMS/escalation_stage 2 - that's accurate history, not
// a bug; the DB and UI both still understand that status for anything
// that already happened. New assignments simply never reach it now.
const STAGE_THRESHOLDS_SEC = {
  1: () => Number(process.env.ESCALATE_RESEND_PUSH_SEC ?? 15),
  2: () => Number(process.env.ESCALATE_DISPATCHER_ALERT_SEC ?? 45),
};

export function startEscalationWorker() {
  const interval = setInterval(() => {
    // Same crash-protection reasoning as the outbox worker - a raw
    // setInterval callback whose promise rejects takes the entire
    // process down by default. This worker drives the assignment
    // timeout ladder, so it especially can't be allowed to silently die
    // mid-event.
    tick().catch((err) => {
      console.error('[escalation] tick failed unexpectedly:', err);
    });
  }, POLL_INTERVAL_MS);
  return () => clearInterval(interval);
}

export async function tick() {
  // Any assignment still PENDING whose age has crossed the next
  // threshold for its current stage gets escalated one step.
  // event_id is joined in here (not on the assignments table itself) so
  // the resulting escalation can be broadcast to the right console.
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.escalation_stage, a.created_at, i.event_id,
            EXTRACT(EPOCH FROM (now() - a.created_at)) AS age_sec
     FROM assignments a
     JOIN incidents i ON i.id = a.incident_id
     WHERE a.status = 'PENDING'`
  );

  for (const row of rows) {
    const nextStage = row.escalation_stage + 1;
    const threshold = STAGE_THRESHOLDS_SEC[nextStage]?.();
    if (threshold === undefined || row.age_sec < threshold) continue;

    await escalate(row.id, nextStage, row.event_id);
  }

  // Outbox sends that failed outright (e.g. a bad/expired push token)
  // shouldn't wait out the clock — jump straight to the dispatcher-alert
  // stage.
  const { rows: hardFailures } = await pool.query(
    `SELECT DISTINCT a.id, i.event_id
     FROM assignments a
     JOIN incidents i ON i.id = a.incident_id
     JOIN outbox_messages om ON om.assignment_id = a.id
     WHERE a.status = 'PENDING'
       AND om.status = 'failed'
       AND a.escalation_stage < 2`
  );
  for (const row of hardFailures) {
    await escalate(row.id, 2, row.event_id);
  }
}

async function escalate(assignmentId, stage, eventId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (stage === 1) {
      // Resend push: queue another outbox row.
      await client.query(
        `INSERT INTO outbox_messages (assignment_id, channel, status, next_attempt_at)
         VALUES ($1, 'push', 'pending', now())`,
        [assignmentId]
      );
      await client.query(`UPDATE assignments SET escalation_stage = 1 WHERE id = $1`, [assignmentId]);
    } else if (stage === 2) {
      // Hand off to a human. Dispatcher console should surface this row
      // as red/UNCONFIRMED and alert — no further automated retries.
      await client.query(
        `UPDATE assignments SET escalation_stage = 2, status = 'UNCONFIRMED' WHERE id = $1`,
        [assignmentId]
      );
    }

    await client.query('COMMIT');
    broadcastEventUpdate(eventId, { type: 'refresh', reason: `assignment.escalation_stage_${stage}` });
    console.log(`[escalation] assignment ${assignmentId} -> stage ${stage}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[escalation] failed to escalate ${assignmentId}:`, err.message);
  } finally {
    client.release();
  }
}
