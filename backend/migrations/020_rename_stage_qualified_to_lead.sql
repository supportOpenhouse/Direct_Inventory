-- Rename the pipeline stage VALUE 'qualified' -> 'lead'.
--
-- `qualified` is the top-of-pipeline stage and the default for new inventory
-- rows. It has always been DISPLAYED as "Lead" in the UI (stageLabel map); this
-- migration brings the stored value in line with that label. `stage` is free
-- TEXT (no CHECK constraint) validated in app code via VALID_STAGES, so no
-- constraint needs touching — only the data, the column default, and the
-- historical activity_log audit rows that recorded the old value.
--
-- All statements are naturally idempotent: the UPDATEs become no-ops once no
-- 'qualified' values remain, and SET DEFAULT is declarative.

BEGIN;

-- 1) Live inventory rows currently sitting in the stage.
UPDATE inventory SET stage = 'lead' WHERE stage = 'qualified';

-- 2) Default for newly-inserted rows (was DEFAULT 'qualified' in 001_init.sql).
ALTER TABLE inventory ALTER COLUMN stage SET DEFAULT 'lead';

-- 3) Historical audit trail. `stage` is a controlled vocabulary, and the user
--    report / funnel read these before/after values directly (see
--    api/activity.py _WINNERS_CTE, which now filters on 'lead'). Rewriting the
--    old value keeps reports consistent across the rename boundary. These
--    columns only ever hold stage slugs for action IN ('stage_change',
--    'bulk_stage_change'); other actions are unaffected.
UPDATE activity_log SET before_value = 'lead' WHERE before_value = 'qualified';
UPDATE activity_log SET after_value  = 'lead' WHERE after_value  = 'qualified';

COMMIT;
