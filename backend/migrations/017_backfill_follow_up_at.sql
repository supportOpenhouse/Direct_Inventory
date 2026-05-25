-- Backfill follow_up_at for legacy rows still missing one. "Posted date" on
-- the Board is rendered from created_at (when WE ingested the lead), not
-- posting_date (the listing site's date), so we default follow_up_at to the
-- IST date portion of created_at to match what the user sees on the Board.
-- Application code now sets this explicitly on insert; this migration is a
-- one-shot cleanup for rows inserted before that change. Idempotent.

UPDATE inventory
SET    follow_up_at = (created_at AT TIME ZONE 'Asia/Kolkata')::DATE
WHERE  follow_up_at IS NULL
  AND  created_at IS NOT NULL;
