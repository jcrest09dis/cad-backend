-- Lets units be grouped by type on the live dashboard board and the
-- admin Units list (EC, Cart, Law, Fire - UK Athletics EMS's actual unit
-- categories). Nullable and unconstrained-by-NOT-NULL on purpose: every
-- existing unit predates this column, so they all start with no type
-- set and fall into an "unspecified" group in the UI until an admin
-- assigns one - no backfill migration needed.
ALTER TABLE units
  ADD COLUMN unit_type TEXT CHECK (unit_type IN ('EC', 'Cart', 'Law', 'Fire'));