-- Production hardening: real admin flag (replaces the shared bootstrap
-- secret) and columns to support real KMS envelope encryption alongside
-- the existing local-key stub.

-- Org-level admin flag, independent of any event's EventStaffing role.
-- This is what /admin/* now checks instead of a shared secret header.
ALTER TABLE staff
  ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- KMS envelope encryption needs to store the per-record encrypted data
-- key alongside the ciphertext it protects (see lib/crypto.js). NULL in
-- local-key mode, since that mode has no per-record data key.
ALTER TABLE incidents
  ADD COLUMN notes_data_key_ciphertext BYTEA;

ALTER TABLE incident_note_revisions
  ADD COLUMN data_key_ciphertext BYTEA;

ALTER TABLE staff
  ADD COLUMN totp_secret_data_key_ciphertext BYTEA;
