-- Rename inventory.reject_reason -> inventory.stage_reason.
--
-- The column historically held only a rejection reason (set when
-- stage='rejected'); it is being generalised to a per-stage reason. This is a
-- pure column rename — the stored values and the NULL-when-not-rejected
-- convention are unchanged.
--
-- RENAME COLUMN has no column-level IF EXISTS, so the rename is wrapped in a
-- guard on information_schema to stay idempotent / re-runnable.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'inventory' AND column_name = 'reject_reason'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'inventory' AND column_name = 'stage_reason'
    ) THEN
        ALTER TABLE inventory RENAME COLUMN reject_reason TO stage_reason;
    END IF;
END $$;
