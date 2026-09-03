-- Adds authenticator-app (TOTP) login support.
--
-- username is the login identifier (distinct from phone, which is used for
-- SMS escalation, not login - kept separate since not every org wants the
-- same value serving both purposes).

ALTER TABLE staff
  ADD COLUMN username TEXT UNIQUE,
  ADD COLUMN totp_secret_ciphertext BYTEA,
  ADD COLUMN totp_secret_key_id TEXT,
  ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN totp_last_step BIGINT; -- replay protection: reject reuse of a code within its own time step
