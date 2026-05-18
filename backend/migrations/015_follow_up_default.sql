-- Default follow_up_at to posting_date on INSERT when the caller did not
-- supply one. Still freely editable afterwards (PATCH /api/inventory/:id and
-- the bulk-update endpoint both allow follow_up_at).
--
-- A column DEFAULT can't reference another column in the same row, so we use
-- a BEFORE INSERT trigger. Covers every insert path: sheet_sync, manual
-- create, future bulk imports, raw SQL.

CREATE OR REPLACE FUNCTION default_inventory_follow_up() RETURNS TRIGGER AS $$
BEGIN
    -- Only fill when the caller left follow_up_at NULL AND we have a
    -- posting_date to copy from. Otherwise leave the column alone.
    IF NEW.follow_up_at IS NULL AND NEW.posting_date IS NOT NULL THEN
        NEW.follow_up_at := NEW.posting_date;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_default_follow_up ON inventory;
CREATE TRIGGER inventory_default_follow_up
    BEFORE INSERT ON inventory
    FOR EACH ROW
    EXECUTE FUNCTION default_inventory_follow_up();

-- One-shot backfill for legacy rows that still have NULL follow_up_at but
-- do have a posting_date. Safe to re-run — only touches NULLs.
UPDATE inventory
SET    follow_up_at = posting_date
WHERE  follow_up_at IS NULL
  AND  posting_date IS NOT NULL;
