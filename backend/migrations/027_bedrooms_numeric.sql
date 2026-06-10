-- Migration 027: support half-BHK (2.5, 3.5) by widening inventory.bedrooms
-- from INT to NUMERIC. Guarded so re-runs are no-ops. Existing integer values
-- are preserved (2 stays 2). Idempotent.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory' AND column_name = 'bedrooms' AND data_type = 'integer'
  ) THEN
    ALTER TABLE inventory ALTER COLUMN bedrooms TYPE NUMERIC;
  END IF;
END $$;

COMMIT;
