-- Rename inventory.reject_reason -> stage_reason.
--
-- The column is generalised to hold a reason for a stage change. The reject
-- flow is unchanged: when stage='rejected', stage_reason is still required and
-- validated against the same reject-reason set. Idempotent: only renames when
-- the old column exists and the new one doesn't, so re-running is safe.
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'inventory' AND column_name = 'reject_reason'
      )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'inventory' AND column_name = 'stage_reason'
      )
  THEN
    ALTER TABLE inventory RENAME COLUMN reject_reason TO stage_reason;
  END IF;
END $$;
