import { pool } from '../src/db/pool.js';

// One-time cleanup: removes all incidents (pre-launch test data) plus
// the 'dana' and 'max' test staff accounts and the 'Test' venue. Run
// once via Render's Shell tab: node scripts/cleanup-test-data.js
//
// Deletion order matters here because of foreign keys - children are
// removed before their parents. audit_log.entity_id has no real FK
// (it's a polymorphic column), so cleaning those rows up is optional
// tidiness, not a requirement for the deletes below to succeed - but
// it's done here anyway so no dangling audit entries are left pointing
// at nothing.

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- All incidents, and everything that hangs off them ----

    const { rows: incidentIds } = await client.query(`SELECT id FROM incidents`);
    const { rows: assignmentIds } = await client.query(`SELECT id FROM assignments`);

    await client.query(
      `DELETE FROM audit_log WHERE entity_type = 'incident' AND entity_id = ANY($1::uuid[])`,
      [incidentIds.map((r) => r.id)]
    );
    await client.query(
      `DELETE FROM audit_log WHERE entity_type = 'assignment' AND entity_id = ANY($1::uuid[])`,
      [assignmentIds.map((r) => r.id)]
    );

    await client.query(`UPDATE units SET current_assignment_id = NULL WHERE current_assignment_id IS NOT NULL`);
    const outbox = await client.query(`DELETE FROM outbox_messages RETURNING id`);
    const assignments = await client.query(`DELETE FROM assignments RETURNING id`);
    const revisions = await client.query(`DELETE FROM incident_note_revisions RETURNING id`);
    const incidents = await client.query(`DELETE FROM incidents RETURNING id`);

    console.log(`Deleted ${incidents.rowCount} incidents, ${assignments.rowCount} assignments, ${revisions.rowCount} note revisions, ${outbox.rowCount} outbox messages.`);

    // ---- Staff: dana and max only ----

    const { rows: testStaff } = await client.query(
      `SELECT id, username FROM staff WHERE username IN ('dana', 'max')`
    );
    const testStaffIds = testStaff.map((s) => s.id);

    if (testStaffIds.length > 0) {
      await client.query(`DELETE FROM unit_staff WHERE staff_id = ANY($1::uuid[])`, [testStaffIds]);
      await client.query(`DELETE FROM event_staffing WHERE staff_id = ANY($1::uuid[])`, [testStaffIds]);
      await client.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [testStaffIds]);
      const deletedStaff = await client.query(`DELETE FROM staff WHERE id = ANY($1::uuid[]) RETURNING username`, [
        testStaffIds,
      ]);
      console.log(`Deleted staff: ${deletedStaff.rows.map((r) => r.username).join(', ')}`);
    } else {
      console.log('No staff named dana/max found - nothing to delete there.');
    }

    // ---- Venue: "Test" only ----

    const { rows: testVenues } = await client.query(`SELECT id FROM venues WHERE name = 'Test'`);
    if (testVenues.length > 0) {
      const testVenueId = testVenues[0].id;

      const { rows: testEvents } = await client.query(`SELECT id, name FROM events WHERE venue_id = $1`, [
        testVenueId,
      ]);
      if (testEvents.length > 0) {
        console.log(
          `NOTE: the "Test" venue has ${testEvents.length} event(s) tied to it (${testEvents
            .map((e) => e.name)
            .join(', ')}) - deleting them along with it.`
        );
        const testEventIds = testEvents.map((e) => e.id);
        await client.query(`DELETE FROM units WHERE event_id = ANY($1::uuid[])`, [testEventIds]);
        await client.query(`DELETE FROM event_staffing WHERE event_id = ANY($1::uuid[])`, [testEventIds]);
        await client.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [testEventIds]);
      }

      await client.query(`DELETE FROM venue_zones WHERE venue_id = $1`, [testVenueId]);
      await client.query(`DELETE FROM venues WHERE id = $1`, [testVenueId]);
      console.log('Deleted venue "Test" and its zones.');
    } else {
      console.log('No venue named "Test" found - nothing to delete there.');
    }

    await client.query('COMMIT');
    console.log('Cleanup complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();