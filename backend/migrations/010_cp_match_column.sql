-- Persist the CP Inventory match verdict on every row instead of recomputing
-- on every page load. NULL = "never scanned yet" or "changed since last scan".
-- The /api/inventory/cp-match-scan admin endpoint populates this; PATCH on
-- match-determining fields (society, bedrooms, floor, tower, unit_no) sets
-- it back to NULL so the next scan re-evaluates.

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS cp_match TEXT;
CREATE INDEX IF NOT EXISTS idx_inventory_cp_match
  ON inventory(cp_match) WHERE cp_match IS NOT NULL;
