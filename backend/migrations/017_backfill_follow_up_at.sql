-- Guarantee follow_up_at is never NULL.
--
-- "Posted date" on the Board is rendered from created_at (when WE ingested the
-- lead), not posting_date (the listing site's date). The user's rule:
-- follow_up_at must always equal created_at's IST date on insert — no blanks.
--
-- Three layers of defence:
--   1. Application code already sets follow_up_at = (NOW() AT TIME ZONE
--      'Asia/Kolkata')::DATE in every Python INSERT path.
--   2. This trigger fills follow_up_at for any other insert that leaves it
--      NULL (raw SQL, future code paths, manual inserts).
--   3. The one-shot UPDATE below backfills every legacy NULL row.
--
-- Replaces the migration-015 trigger that used posting_date.
-- Safe to re-run.

CREATE OR REPLACE FUNCTION default_inventory_follow_up() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.follow_up_at IS NULL THEN
        NEW.follow_up_at := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_default_follow_up ON inventory;
CREATE TRIGGER inventory_default_follow_up
    BEFORE INSERT ON inventory
    FOR EACH ROW
    EXECUTE FUNCTION default_inventory_follow_up();

-- Backfill every legacy NULL row. created_at has DEFAULT NOW() since
-- migration 001, so the IS NOT NULL guard is belt-and-suspenders only.
UPDATE inventory
SET    follow_up_at = (created_at AT TIME ZONE 'Asia/Kolkata')::DATE
WHERE  follow_up_at IS NULL
  AND  created_at IS NOT NULL;
