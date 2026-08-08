-- One-time backfill of assigned_at for the rows migration 037 left NULL (every
-- pre-existing lead). Baseline = created_at; but if the lead has any
-- assigned_rm_ids change in the activity log, use the LATEST such date — that's
-- when the current RM was put on it. Reassignments are logged with
-- field='assigned_rm_ids' (single endpoint and bulk both), entity_id = oh_id.
--
-- Scoped to assigned_at IS NULL, so it's idempotent: rows already stamped (new
-- leads, post-migration reassignments) are untouched, and re-running is a no-op.
-- To force a full recompute instead, drop the WHERE clause.
UPDATE inventory i
SET assigned_at = COALESCE(
        (SELECT MAX(a.created_at)
           FROM activity_log a
          WHERE a.entity_type = 'inventory'
            AND a.entity_id   = i.oh_id
            AND a.field       = 'assigned_rm_ids'),
        i.created_at
    )
WHERE i.assigned_at IS NULL;
