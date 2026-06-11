-- 030_perf_indexes.sql — indexes for hot inventory list/filter queries.
--
-- idx_activity_log_entity_action: per-row lookups filter `entity_id = ? AND
-- action IN (...)` on inventory activity; idx_activity_log_entity_created
-- (023) covers (entity_id, created_at), so each lookup still scans every
-- action for the entity. This partial composite turns those into index seeks.
--
-- idx_inventory_created_at: the inventory list sorts newest-first.
--
-- idx_inventory_stage (001) and idx_inventory_follow_up_at (006) already
-- exist with identical definitions, so they're not repeated here. Idempotent.
CREATE INDEX IF NOT EXISTS idx_activity_log_entity_action
    ON activity_log (entity_id, action)
    WHERE entity_type = 'inventory';

CREATE INDEX IF NOT EXISTS idx_inventory_created_at
    ON inventory (created_at DESC);
