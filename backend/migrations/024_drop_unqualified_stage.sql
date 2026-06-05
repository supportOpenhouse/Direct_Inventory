-- Migration 024: finish the 'unqualified' -> 'lead' rename.
-- The backend no longer recognises 'unqualified' (the read-time fold was
-- removed), so convert any remaining rows AND historical activity_log values
-- (before_value / after_value) to 'lead' — otherwise user-report winners and
-- stage counts would miss those rows. Idempotent; safe to re-run.
BEGIN;

UPDATE inventory SET stage = 'lead' WHERE stage = 'unqualified';
ALTER TABLE inventory ALTER COLUMN stage SET DEFAULT 'lead';

UPDATE activity_log SET before_value = 'lead'
 WHERE entity_type = 'inventory' AND before_value = 'unqualified';
UPDATE activity_log SET after_value = 'lead'
 WHERE entity_type = 'inventory' AND after_value = 'unqualified';

COMMIT;
