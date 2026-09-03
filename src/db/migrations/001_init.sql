-- CAD initial schema
-- Mirrors the whiteboarded data model: Event, Staff, EventStaffing, Unit,
-- VenueZone, Incident, IncidentNoteRevision, Assignment, OutboxMessage, AuditLog.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE venue_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES venues(id),
  label TEXT NOT NULL
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  venue_id UUID NOT NULL REFERENCES venues(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))
);

CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role TEXT NOT NULL, -- EMT / paramedic / nurse / dispatcher / admin
  phone TEXT,
  device_push_token TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Pools staff across events; also the row that grants "currently working this venue" access
CREATE TABLE event_staffing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  staff_id UUID NOT NULL REFERENCES staff(id),
  role_for_event TEXT NOT NULL, -- field_staff | dispatcher | admin
  checked_in_at TIMESTAMPTZ,
  checked_out_at TIMESTAMPTZ,
  UNIQUE (event_id, staff_id)
);

CREATE TABLE units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (
    status IN ('AVAILABLE','ENROUTE','ON_SCENE','TRANSPORTING','AT_DESTINATION','OUT_OF_SERVICE')
  ),
  current_assignment_id UUID -- FK added after assignments table exists
);

-- NOTE: this wasn't in the original whiteboard — a Unit (e.g. "Medic 1")
-- needs to map to the staff actually crewing it, so push/SMS delivery
-- has somewhere to go. Modeled many-to-many since a unit can carry more
-- than one person (e.g. a two-person medic team).
CREATE TABLE unit_staff (
  unit_id UUID NOT NULL REFERENCES units(id),
  staff_id UUID NOT NULL REFERENCES staff(id),
  PRIMARY KEY (unit_id, staff_id)
);

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  location_zone_id UUID NOT NULL REFERENCES venue_zones(id),
  type TEXT NOT NULL, -- medical | trauma | other
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  notes_ciphertext BYTEA, -- current note content, envelope-encrypted (see lib/crypto.js)
  notes_key_id TEXT,      -- which data key encrypted it, for key rotation
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DISPATCHED','RESOLVED','CANCELLED')),
  created_by UUID NOT NULL REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full revision history of notes, not just current text. Gives us both
-- "who wrote what when" and most of the audit trail for free.
CREATE TABLE incident_note_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  author_id UUID NOT NULL REFERENCES staff(id),
  content_ciphertext BYTEA NOT NULL,
  notes_key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  dispatcher_id UUID NOT NULL REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING','ACKED','ESCALATED_SMS','UNCONFIRMED','CANCELLED','COMPLETED')
  ),
  escalation_stage INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

ALTER TABLE units
  ADD CONSTRAINT fk_units_current_assignment
  FOREIGN KEY (current_assignment_id) REFERENCES assignments(id);

-- Prevents double-booking a unit: only one "live" assignment per unit at a time.
CREATE UNIQUE INDEX one_active_assignment_per_unit
  ON assignments (unit_id)
  WHERE status IN ('PENDING','ACKED','ESCALATED_SMS');

-- Prevents two dispatchers independently dispatching different units
-- to the same incident.
CREATE UNIQUE INDEX one_active_assignment_per_incident
  ON assignments (incident_id)
  WHERE status IN ('PENDING','ACKED','ESCALATED_SMS');

-- Outbox pattern: write the "must deliver this" intent in the same
-- transaction as the assignment, worker polls and sends.
CREATE TABLE outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES assignments(id),
  channel TEXT NOT NULL CHECK (channel IN ('push','sms')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only. Every read/write touching incident notes gets a row.
-- HIPAA cares about who *viewed* PHI, not just who changed it.
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES staff(id),
  action TEXT NOT NULL, -- e.g. 'incident.notes.read', 'incident.notes.write'
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignments_status ON assignments(status);
CREATE INDEX idx_outbox_pending ON outbox_messages(status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_incidents_event_status ON incidents(event_id, status);
CREATE INDEX idx_event_staffing_active ON event_staffing(event_id, staff_id) WHERE checked_out_at IS NULL;
