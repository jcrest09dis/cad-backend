import { pool } from '../db/pool.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';
import { broadcastEventUpdate } from '../services/liveUpdates.js';
import { closeEvent } from '../services/eventLifecycle.js';

/**
 * Org-level admin endpoints: the records that have to exist before any
 * event-scoped RBAC (field_staff/dispatcher/admin via EventStaffing) can
 * apply to anyone. Gated by a real staff.is_admin flag on the caller's
 * own JWT - replaces the old shared bootstrap secret. See
 * lib/seedAdmin.js for how the very first admin gets that flag set.
 */
export default async function adminRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireGlobalAdmin);

  // ---- Staff ----
  fastify.post('/admin/staff', async (request, reply) => {
    const { name, role, phone, username } = request.body;
    const { rows } = await pool.query(
      `INSERT INTO staff (name, role, phone, username, active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id`,
      [name, role, phone ?? null, username ?? null]
    );
    reply.code(201).send({ staffId: rows[0].id });
  });

  fastify.get('/admin/staff', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, name, role, phone, username, active, is_admin FROM staff ORDER BY name`
    );
    reply.send(rows);
  });

  // Edit a staff record. Partial update - only fields present in the
  // body are changed. Deliberately does NOT touch is_admin (that's
  // set-admin below, kept separate since it's a more sensitive action)
  // and guards against deactivating the last usable admin the same way
  // set-admin guards against demoting them - a deactivated admin can't
  // log in, so "is_admin but inactive" is functionally the same dead
  // end as having no admin at all.
  fastify.patch('/admin/staff/:id', async (request, reply) => {
    const { name, role, phone, username, active } = request.body;

    if (active === false) {
      const { rows: target } = await pool.query(`SELECT is_admin FROM staff WHERE id = $1`, [request.params.id]);
      if (target.length === 0) {
        reply.code(404).send({ error: 'staff not found' });
        return;
      }
      if (target[0].is_admin) {
        const { rows: usableAdmins } = await pool.query(
          `SELECT count(*) FROM staff WHERE is_admin = TRUE AND active = TRUE`
        );
        if (Number(usableAdmins[0].count) <= 1) {
          reply.code(409).send({ error: 'cannot deactivate the last usable admin' });
          return;
        }
      }
    }

    const fields = [];
    const params = [];
    function set(column, value) {
      if (value === undefined) return;
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    }
    set('name', name);
    set('role', role);
    set('phone', phone);
    set('username', username);
    set('active', active);

    if (fields.length === 0) {
      reply.code(400).send({ error: 'no fields to update' });
      return;
    }

    params.push(request.params.id);
    try {
      const { rows } = await pool.query(
        `UPDATE staff SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id`,
        params
      );
      if (rows.length === 0) {
        reply.code(404).send({ error: 'staff not found' });
        return;
      }
      reply.send({ updated: true });
    } catch (err) {
      if (err.code === '23505') {
        reply.code(409).send({ error: 'that username is already taken' });
        return;
      }
      throw err;
    }
  });

  // Hard delete - only when the record has zero history anywhere in the
  // schema. Staff.id is referenced by assignments, incidents, note
  // revisions, and the audit log; deleting someone with real history
  // would either hit a foreign-key error or, worse, silently damage the
  // audit trail. Deactivation (via PATCH above) is the real "remove this
  // person" action for anyone who's actually done anything in the
  // system - this is only for cleaning up a genuine mistake (e.g. a
  // duplicate/typo'd record created and never used).
  fastify.delete('/admin/staff/:id', async (request, reply) => {
    const { rows: refs } = await pool.query(
      `SELECT
         (SELECT count(*) FROM event_staffing WHERE staff_id = $1) AS event_staffing,
         (SELECT count(*) FROM unit_staff WHERE staff_id = $1) AS unit_staff,
         (SELECT count(*) FROM incidents WHERE created_by = $1) AS incidents,
         (SELECT count(*) FROM assignments WHERE dispatcher_id = $1) AS assignments,
         (SELECT count(*) FROM incident_note_revisions WHERE author_id = $1) AS note_revisions,
         (SELECT count(*) FROM audit_log WHERE actor_id = $1) AS audit_log`,
      [request.params.id]
    );
    const counts = refs[0];
    const hasHistory = Object.values(counts).some((c) => Number(c) > 0);
    if (hasHistory) {
      reply.code(409).send({
        error: 'this staff member has history and cannot be deleted - deactivate them instead',
        details: counts,
      });
      return;
    }

    const { rows } = await pool.query(`DELETE FROM staff WHERE id = $1 RETURNING id`, [request.params.id]);
    if (rows.length === 0) {
      reply.code(404).send({ error: 'staff not found' });
      return;
    }
    reply.send({ deleted: true });
  });

  // Promote or demote another staff member's global admin status. An
  // admin can demote themselves (e.g. handing off the role) but not
  // remove the very last admin, since that would recreate the exact
  // bootstrap problem this whole mechanism replaced.
  fastify.post('/admin/staff/:id/set-admin', async (request, reply) => {
    const { isAdmin } = request.body;

    if (!isAdmin) {
      const { rows: adminCount } = await pool.query(
        `SELECT count(*) FROM staff WHERE is_admin = TRUE AND active = TRUE`
      );
      if (Number(adminCount[0].count) <= 1) {
        reply.code(409).send({ error: 'cannot remove the last remaining admin' });
        return;
      }
    }

    await pool.query(`UPDATE staff SET is_admin = $1 WHERE id = $2`, [Boolean(isAdmin), request.params.id]);
    reply.send({ updated: true });
  });

  // ---- Venues ----
  fastify.post('/admin/venues', async (request, reply) => {
    const { name } = request.body;
    const { rows } = await pool.query(
      `INSERT INTO venues (name) VALUES ($1) RETURNING id`,
      [name]
    );
    reply.code(201).send({ venueId: rows[0].id });
  });

  // has_map lets the console's admin Venues tab decide whether to show
  // "Upload map" or "Replace map" / offer the click-to-place tool.
  fastify.get('/admin/venues', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, name, (map_image IS NOT NULL) AS has_map FROM venues ORDER BY name`
    );
    reply.send(rows);
  });

  // ---- Venue map image ----
  // Image stored as bytes directly in Postgres (BYTEA) rather than a
  // separate object-storage service - simplest option given the low
  // volume (a handful of venues, uploaded rarely) and avoids adding a
  // new infrastructure dependency for this feature. Sent as base64 JSON
  // rather than multipart, since @fastify/multipart isn't already a
  // dependency here - app.js raises the body size limit to accommodate
  // the ~33% base64 overhead.
  fastify.post('/admin/venues/:venueId/map', async (request, reply) => {
    const { imageBase64, contentType } = request.body;
    if (!imageBase64 || !contentType) {
      reply.code(400).send({ error: 'imageBase64 and contentType are required' });
      return;
    }
    let buffer;
    try {
      buffer = Buffer.from(imageBase64, 'base64');
    } catch {
      reply.code(400).send({ error: 'imageBase64 is not valid base64' });
      return;
    }
    if (buffer.length === 0) {
      reply.code(400).send({ error: 'decoded image is empty' });
      return;
    }
    const { rows } = await pool.query(
      `UPDATE venues SET map_image = $1, map_image_content_type = $2 WHERE id = $3 RETURNING id`,
      [buffer, contentType, request.params.venueId]
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: 'venue not found' });
      return;
    }
    reply.send({ updated: true });
  });

  // Remove a venue's map image (e.g. replacing it with a corrected
  // scan) - also clears every zone's placed coordinates for this venue,
  // since a coordinate only means something relative to the specific
  // image it was clicked on.
  fastify.post('/admin/venues/:venueId/map/delete', async (request, reply) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE venues SET map_image = NULL, map_image_content_type = NULL WHERE id = $1`,
        [request.params.venueId]
      );
      await client.query(
        `UPDATE venue_zones SET map_x = NULL, map_y = NULL WHERE venue_id = $1`,
        [request.params.venueId]
      );
      await client.query('COMMIT');
      reply.send({ deleted: true });
    } catch (err) {
      await client.query('ROLLBACK');
      reply.code(500).send({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- Venue zones (the location dropdown per venue, and now also the
  // click-to-place map positions) ----
  fastify.post('/admin/venues/:venueId/zones', async (request, reply) => {
    const { label } = request.body;
    const { rows } = await pool.query(
      `INSERT INTO venue_zones (venue_id, label) VALUES ($1, $2) RETURNING id`,
      [request.params.venueId, label]
    );
    reply.code(201).send({ zoneId: rows[0].id });
  });

  // Bulk import - built for populating a venue with an entire stadium's
  // worth of sections/suites/named areas at once (dozens to hundreds of
  // entries) rather than one at a time through the single-zone form
  // above. No duplicate detection (same as the single-add route above -
  // matching existing behavior rather than introducing new rules only
  // for this path).
  fastify.post('/admin/venues/:venueId/zones/batch', async (request, reply) => {
    const { labels } = request.body;
    if (!Array.isArray(labels) || labels.length === 0) {
      reply.code(400).send({ error: 'labels must be a non-empty array' });
      return;
    }
    const cleanLabels = labels.map((l) => String(l).trim()).filter(Boolean);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const label of cleanLabels) {
        await client.query(`INSERT INTO venue_zones (venue_id, label) VALUES ($1, $2)`, [
          request.params.venueId,
          label,
        ]);
      }
      await client.query('COMMIT');
      reply.code(201).send({ created: cleanLabels.length });
    } catch (err) {
      await client.query('ROLLBACK');
      reply.code(500).send({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Now also returns map_x/map_y so the console's click-to-place tool
  // can show which zones are already placed on the venue's map image.
  fastify.get('/admin/venues/:venueId/zones', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, label, map_x, map_y FROM venue_zones WHERE venue_id = $1 ORDER BY label`,
      [request.params.venueId]
    );
    reply.send(rows);
  });

  // Edit a single zone's label (e.g. fixing a typo or updating a row
  // range without touching every other zone).
  fastify.post('/admin/zones/:zoneId', async (request, reply) => {
    const { label } = request.body;
    if (!label || !label.trim()) {
      reply.code(400).send({ error: 'label is required' });
      return;
    }
    const { rows } = await pool.query(
      `UPDATE venue_zones SET label = $1 WHERE id = $2 RETURNING id`,
      [label.trim(), request.params.zoneId]
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: 'zone not found' });
      return;
    }
    reply.send({ updated: true });
  });

  // Save (or clear, by passing mapX: null, mapY: null) a single zone's
  // click-to-place position on its venue's map image. Fractional 0-1
  // coordinates - see migration 009 for why.
  fastify.post('/admin/zones/:zoneId/map-position', async (request, reply) => {
    const { mapX, mapY } = request.body;
    const hasPosition = typeof mapX === 'number' && typeof mapY === 'number';
    const isExplicitClear = mapX === null && mapY === null;
    if (!hasPosition && !isExplicitClear) {
      reply.code(400).send({ error: 'mapX and mapY must both be numbers, or both null to clear' });
      return;
    }
    const { rows } = await pool.query(
      `UPDATE venue_zones SET map_x = $1, map_y = $2 WHERE id = $3 RETURNING id`,
      [hasPosition ? mapX : null, hasPosition ? mapY : null, request.params.zoneId]
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: 'zone not found' });
      return;
    }
    reply.send({ updated: true });
  });

  // Delete a single zone. Same historical-display caveat as the
  // wholesale replace route above applies here too, at a smaller scale -
  // any incident whose location_zone_id points at this row (only
  // possible pre-free-text-location) loses its zone_label display.
  fastify.post('/admin/zones/:zoneId/delete', async (request, reply) => {
    const { rows } = await pool.query(
      `DELETE FROM venue_zones WHERE id = $1 RETURNING id`,
      [request.params.zoneId]
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: 'zone not found' });
      return;
    }
    reply.send({ deleted: true });
  });

  // Wholesale replace - deletes every existing zone for the venue and
  // inserts the new list. Built for re-importing a corrected/updated
  // zone list (e.g. adding row ranges to labels that already existed)
  // without ending up with both the old and new versions coexisting as
  // duplicate suggestions. Worth knowing: any historical incident whose
  // location_zone_id still points at a deleted row (only possible for
  // incidents created before locations became free text - see
  // 005_incident_free_text_location.sql) would lose its zone_label
  // display, since that display is computed via
  // COALESCE(location_text, <joined venue_zones label>) and the join
  // would now find nothing. Replacing zones this way also discards any
  // map_x/map_y placements on the replaced rows, since new rows get
  // fresh ids - re-place them on the map afterward if needed.
  fastify.post('/admin/venues/:venueId/zones/replace', async (request, reply) => {
    const { labels } = request.body;
    if (!Array.isArray(labels) || labels.length === 0) {
      reply.code(400).send({ error: 'labels must be a non-empty array' });
      return;
    }
    const cleanLabels = labels.map((l) => String(l).trim()).filter(Boolean);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM venue_zones WHERE venue_id = $1`, [request.params.venueId]);
      for (const label of cleanLabels) {
        await client.query(`INSERT INTO venue_zones (venue_id, label) VALUES ($1, $2)`, [
          request.params.venueId,
          label,
        ]);
      }
      await client.query('COMMIT');
      reply.send({ replaced: cleanLabels.length });
    } catch (err) {
      await client.query('ROLLBACK');
      reply.code(500).send({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- Events ----
  fastify.post('/admin/events', async (request, reply) => {
    const { name, venueId, startTime, endTime } = request.body;
    const { rows } = await pool.query(
      `INSERT INTO events (name, venue_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [name, venueId, startTime, endTime ?? null]
    );
    reply.code(201).send({ eventId: rows[0].id });
  });

  fastify.get('/admin/events', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, name, venue_id, start_time, end_time, status FROM events ORDER BY start_time DESC`
    );
    reply.send(rows);
  });

  // Closing an event does real cleanup, not just a status flip - see
  // services/eventLifecycle.js's closeEvent for the full explanation.
  // Shared with the dispatcher-facing close route on the live dashboard.
  fastify.post('/admin/events/:eventId/close', async (request, reply) => {
    try {
      const result = await closeEvent({ eventId: request.params.eventId });
      reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Reopening does NOT restore any units automatically - they were
  // deliberately returned to the pool on close, and re-assigning them
  // (via the Units tab's existing assign-to-event dropdown) is a fresh,
  // explicit admin decision, not something to silently redo.
  fastify.post('/admin/events/:eventId/reopen', async (request, reply) => {
    const { rows } = await pool.query(
      `UPDATE events SET status = 'active' WHERE id = $1 RETURNING id`,
      [request.params.eventId]
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: 'event not found' });
      return;
    }
    reply.send({ reopened: true });
  });

    // Hard delete an event and everything tied to it - deliberately
  // unconditional (unlike the venue/staff deletes above, which block
  // when real history exists). Incidents, their assignments/note
  // revisions/outbox messages, and this event's staffing records are
  // all removed. Units are NOT deleted - they're pooled resources, so
  // they're returned to the pool (same cleanup as closeEvent) rather
  // than destroyed.
  fastify.post('/admin/events/:eventId/delete', async (request, reply) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: eventRows } = await client.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [
        request.params.eventId,
      ]);
      if (eventRows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404).send({ error: 'event not found' });
        return;
      }

      const { rows: incidentRows } = await client.query(`SELECT id FROM incidents WHERE event_id = $1`, [
        request.params.eventId,
      ]);
      const incidentIds = incidentRows.map((r) => r.id);

      const { rows: assignmentRows } = await client.query(
        `SELECT id FROM assignments WHERE incident_id = ANY($1::uuid[])`,
        [incidentIds]
      );
      const assignmentIds = assignmentRows.map((r) => r.id);

      // Tidy audit_log rows pointing at data that's about to be gone -
      // entity_id has no real FK, so this isn't required for the deletes
      // below to succeed, just keeps the audit trail from having dangling
      // references to nothing.
      await client.query(
        `DELETE FROM audit_log WHERE entity_type = 'incident' AND entity_id = ANY($1::uuid[])`,
        [incidentIds]
      );
      await client.query(
        `DELETE FROM audit_log WHERE entity_type = 'assignment' AND entity_id = ANY($1::uuid[])`,
        [assignmentIds]
      );

      await client.query(
        `UPDATE units SET current_assignment_id = NULL WHERE current_assignment_id = ANY($1::uuid[])`,
        [assignmentIds]
      );
      await client.query(`DELETE FROM outbox_messages WHERE assignment_id = ANY($1::uuid[])`, [assignmentIds]);
      await client.query(`DELETE FROM assignments WHERE id = ANY($1::uuid[])`, [assignmentIds]);
      await client.query(`DELETE FROM incident_note_revisions WHERE incident_id = ANY($1::uuid[])`, [incidentIds]);
      await client.query(`DELETE FROM incidents WHERE id = ANY($1::uuid[])`, [incidentIds]);

      // Units aren't destroyed - return them to the pool, same cleanup
      // closeEvent already does for a normal close.
      const { rows: unitRows } = await client.query(`SELECT id FROM units WHERE event_id = $1`, [
        request.params.eventId,
      ]);
      const unitIds = unitRows.map((r) => r.id);
      await client.query(`DELETE FROM unit_staff WHERE unit_id = ANY($1::uuid[])`, [unitIds]);
      await client.query(
        `UPDATE units SET event_id = NULL, current_assignment_id = NULL, status = 'AVAILABLE' WHERE id = ANY($1::uuid[])`,
        [unitIds]
      );

      await client.query(`DELETE FROM event_staffing WHERE event_id = $1`, [request.params.eventId]);
      await client.query(`DELETE FROM events WHERE id = $1`, [request.params.eventId]);

      await client.query('COMMIT');
      reply.send({
        deleted: true,
        incidentsDeleted: incidentIds.length,
        unitsReturnedToPool: unitIds.length,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      reply.code(500).send({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- Units (pooled - can exist without an event, same idea as
  // staff being pooled and checked into events rather than recreated
  // per event) ----
  fastify.post('/admin/events/:eventId/units', async (request, reply) => {
    const { label } = request.body;
    const { rows } = await pool.query(
      `INSERT INTO units (event_id, label, status) VALUES ($1, $2, 'AVAILABLE') RETURNING id`,
      [request.params.eventId, label]
    );
    reply.code(201).send({ unitId: rows[0].id });
  });

  // Create a unit with no event yet - stays in the pool until assigned
  // (see /admin/units/:unitId/assign-event below).
  fastify.post('/admin/units', async (request, reply) => {
    const { label } = request.body;
    if (!label || !label.trim()) {
      reply.code(400).send({ error: 'label is required' });
      return;
    }
    const { rows } = await pool.query(
      `INSERT INTO units (event_id, label, status) VALUES (NULL, $1, 'AVAILABLE') RETURNING id`,
      [label.trim()]
    );
    reply.code(201).send({ unitId: rows[0].id });
  });

  fastify.get('/admin/events/:eventId/units', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, label, status FROM units WHERE event_id = $1 ORDER BY label`,
      [request.params.eventId]
    );
    reply.send(rows);
  });

  // Every unit across every event, flat, plus pooled (unassigned) ones -
  // for the admin Units tab's main list. LEFT JOIN since event_id can be
  // null now; event_name/event_status come back null for pooled units.
  fastify.get('/admin/units', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.label, u.status, u.event_id, e.name AS event_name, e.status AS event_status
       FROM units u
       LEFT JOIN events e ON e.id = u.event_id
       ORDER BY e.start_time DESC NULLS FIRST, u.label`
    );
    reply.send(rows);
  });

  // Assign a pooled unit to an event (or move it between events), or
  // return it to the pool by passing eventId: null. This is what
  // actually makes a unit usable for live dispatch - GET
  // /events/:eventId/units only ever shows units with that event_id.
  fastify.post('/admin/units/:unitId/assign-event', async (request, reply) => {
    const { eventId } = request.body;
    const { rows } = await pool.query(
      `UPDATE units SET event_id = $1 WHERE id = $2 RETURNING id`,
      [eventId ?? null, request.params.unitId]
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: 'unit not found' });
      return;
    }
    reply.send({ updated: true });
  });

  fastify.get('/admin/units/:unitId/crew', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.name FROM unit_staff us JOIN staff s ON s.id = us.staff_id
       WHERE us.unit_id = $1 ORDER BY s.name`,
      [request.params.unitId]
    );
    reply.send(rows);
  });

  // Crew a unit with one or more staff (many-to-many - see README on why
  // this table exists). Additive; call again to add more crew, or use the
  // DELETE-equivalent below to remove someone.
  fastify.post('/admin/units/:unitId/crew', async (request, reply) => {
    const { staffId } = request.body;
    await pool.query(
      `INSERT INTO unit_staff (unit_id, staff_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [request.params.unitId, staffId]
    );
    reply.code(201).send({ crewed: true });
  });

  fastify.post('/admin/units/:unitId/crew/remove', async (request, reply) => {
    const { staffId } = request.body;
    await pool.query(
      `DELETE FROM unit_staff WHERE unit_id = $1 AND staff_id = $2`,
      [request.params.unitId, staffId]
    );
    reply.send({ removed: true });
  });

  // ---- Event staffing (check-in/out; this is what grants event-scoped
  // access in requireEventMembership - see middleware/auth.js) ----
  fastify.post('/admin/events/:eventId/staffing', async (request, reply) => {
    const { staffId, roleForEvent } = request.body; // 'field_staff' | 'dispatcher' | 'admin'
    const { rows } = await pool.query(
      `INSERT INTO event_staffing (event_id, staff_id, role_for_event, checked_in_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (event_id, staff_id)
       DO UPDATE SET role_for_event = EXCLUDED.role_for_event, checked_in_at = now(), checked_out_at = NULL
       RETURNING id`,
      [request.params.eventId, staffId, roleForEvent]
    );
    reply.code(201).send({ eventStaffingId: rows[0].id });
  });

  fastify.post('/admin/events/:eventId/staffing/:staffId/checkout', async (request, reply) => {
    await pool.query(
      `UPDATE event_staffing SET checked_out_at = now()
       WHERE event_id = $1 AND staff_id = $2`,
      [request.params.eventId, request.params.staffId]
    );
    reply.send({ checkedOut: true });
  });

  fastify.get('/admin/events/:eventId/staffing', async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT es.id, es.staff_id, s.name, es.role_for_event, es.checked_in_at, es.checked_out_at
       FROM event_staffing es JOIN staff s ON s.id = es.staff_id
       WHERE es.event_id = $1
       ORDER BY es.checked_in_at DESC NULLS LAST`,
      [request.params.eventId]
    );
    reply.send(rows);
  });
}