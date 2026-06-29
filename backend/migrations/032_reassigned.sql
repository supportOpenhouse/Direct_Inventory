-- 032_reassigned.sql — flag leads manually reassigned to a different RM so the
-- new RM sees them as priority (colored star + sort bump). reassigned_by_id is
-- the user who reassigned; the star color is stored on reassign from that user's
-- role. Idempotent.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS reassigned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS reassigned_by_id INT REFERENCES users(id);

-- Partial index: the smart sort floats reassigned leads to the top and the flag
-- is filterable; only the TRUE rows matter.
CREATE INDEX IF NOT EXISTS idx_inventory_reassigned ON inventory (reassigned) WHERE reassigned = TRUE;
