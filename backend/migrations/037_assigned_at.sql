-- assigned_at: when the lead was assigned to its CURRENT RM (as opposed to when
-- the row was created). Set to NOW() on create and bumped on every reassignment
-- (single + bulk), so a reassigned lead shows the reassignment date.
--
-- Two statements on purpose: adding the column WITHOUT a default leaves existing
-- rows NULL (a separate backfill script will set them from assignment history),
-- and SET DEFAULT afterwards only affects future inserts — it does NOT touch the
-- existing NULLs.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE inventory ALTER COLUMN assigned_at SET DEFAULT NOW();

-- Range filters on assigned_at / created_at hit these.
CREATE INDEX IF NOT EXISTS idx_inventory_assigned_at ON inventory(assigned_at);
CREATE INDEX IF NOT EXISTS idx_inventory_created_at  ON inventory(created_at);
