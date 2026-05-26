-- Multi-RM support per property.
--
-- Replaces the single `assigned_rm_id` (INT) with `assigned_rm_ids` (INT[]).
-- The old column is kept in place as a frozen backup — nothing reads or
-- writes it after this migration. Drop in a future migration once we're
-- confident everything works.
--
-- Safe to re-run.

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS assigned_rm_ids INT[] NOT NULL DEFAULT '{}'::INT[];

-- Backfill from the legacy single column for rows that still have an empty
-- array. Idempotent — running again is a no-op for rows already populated.
UPDATE inventory
SET assigned_rm_ids = ARRAY[assigned_rm_id]
WHERE assigned_rm_id IS NOT NULL
  AND cardinality(assigned_rm_ids) = 0;

-- GIN index for the `= ANY(...)` lookups used by _scope_clause and the RM
-- filter. Tiny payload (just integer ids), cheap to maintain.
CREATE INDEX IF NOT EXISTS idx_inventory_assigned_rm_ids
  ON inventory USING GIN (assigned_rm_ids);
