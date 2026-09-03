import { pool } from '../db/pool.js';

/**
 * Records an audit log entry. Called for every read AND write touching
 * Incident.notes — HIPAA audit requirements care about who viewed PHI,
 * not just who changed it. Append-only at the DB grant level (see migration).
 */
export async function audit(client, { actorId, action, entityType, entityId }) {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id)
     VALUES ($1, $2, $3, $4)`,
    [actorId, action, entityType, entityId]
  );
}
