-- Supports the incident history/reporting view - without this there's no
-- way to compute how long an incident took to resolve, only when it was
-- created. Set by the existing resolve/cancel status-change route.
ALTER TABLE incidents
  ADD COLUMN closed_at TIMESTAMPTZ;
