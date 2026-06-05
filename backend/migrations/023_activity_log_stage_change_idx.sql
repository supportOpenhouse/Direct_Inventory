-- Speeds up the per-row morning-stage reconstruction in /api/home/summary
-- (Today's Task) and the NEW-badge flags in /api/inventory: those run a
-- correlated `SELECT ... WHERE entity_id = ? AND action IN (...) ORDER BY
-- created_at LIMIT 1` per row. idx_activity_log_entity covers only
-- (entity_type, entity_id), so each lookup still sorts by created_at. This
-- partial composite index turns each into a single index seek. Idempotent.
CREATE INDEX IF NOT EXISTS idx_activity_log_entity_created
    ON activity_log (entity_id, created_at)
    WHERE entity_type = 'inventory';
