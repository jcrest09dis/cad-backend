-- Add "Rupp Cart" as a distinct unit type alongside EC/Cart/Law/Fire.
-- Postgres has no ALTER CHECK, so this drops and recreates the constraint
-- with the expanded value list.
ALTER TABLE units DROP CONSTRAINT units_unit_type_check;
ALTER TABLE units ADD CONSTRAINT units_unit_type_check
  CHECK (unit_type IN ('EC', 'Cart', 'Rupp Cart', 'Law', 'Fire'));