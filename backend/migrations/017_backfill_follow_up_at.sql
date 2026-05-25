-- Backfill follow_up_at = posting_date for any legacy rows still missing one.
-- Application code (sheet_sync.py, api/inventory.py, scripts/bulk_seed.py) now
-- sets follow_up_at explicitly on insert, so this is a one-shot cleanup for
-- rows inserted before that change. Safe to re-run — only touches NULLs.

UPDATE inventory
SET    follow_up_at = posting_date
WHERE  follow_up_at IS NULL
  AND  posting_date IS NOT NULL;
