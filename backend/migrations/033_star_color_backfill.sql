-- 033_star_color_backfill.sql — make star_color the single stored source of the
-- row star. Previously the star was COMPUTED at render time from
-- reassigned/priority/cp_match; now it's read straight from star_color, so
-- backfill the rows that relied on that computation. Only NULL star_color is
-- filled, preserving existing manual 'yellow'/'none' picks. Idempotent.

-- The CHECK constraint (migration 014) only allowed red/green/yellow/none, so
-- the new reassign colours pink/blue must be permitted before we store them —
-- otherwise reassign / the colour picker / the backfill below all hit
-- inventory_star_color_chk. Widen it first.
ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_star_color_chk;
ALTER TABLE inventory ADD CONSTRAINT inventory_star_color_chk
  CHECK (star_color IS NULL OR star_color IN ('red', 'green', 'yellow', 'pink', 'blue', 'none'));

UPDATE inventory SET star_color = CASE
    WHEN reassigned AND (SELECT u.role FROM users u WHERE u.id = reassigned_by_id) = 'admin'   THEN 'pink'
    WHEN reassigned AND (SELECT u.role FROM users u WHERE u.id = reassigned_by_id) = 'manager' THEN 'blue'
    WHEN priority THEN 'yellow'
    WHEN cp_match = 'perfect' THEN 'green'
    WHEN cp_match = 'partial' THEN 'red'
    ELSE star_color
END
WHERE star_color IS NULL;
