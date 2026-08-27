-- 045_drop_frozen_columns.sql — drop two long-frozen `inventory` columns.
--
-- Both were superseded years ago and are no longer read or written by the app:
--   * assigned_rm_id (single INT)  → replaced by assigned_rm_ids INT[]  (018_multi_rm)
--   * notes          (single TEXT) → replaced by note_thread JSONB      (017_note_thread)
--
-- As of this change the backend no longer projects or sorts on them
-- (backend/api/inventory/lists.py `_LIST_COLS`, `_common.py` sort map). The only
-- remaining `assigned_rm_id` / `notes` references in code are request-body params
-- and the separate `tickets.assigned_rm_id` column — neither touched here.
--
-- Idempotent: DROP COLUMN IF EXISTS makes a re-run a no-op. Destructive (drops the
-- old data in those columns) — review before running.

ALTER TABLE inventory DROP COLUMN IF EXISTS assigned_rm_id;
ALTER TABLE inventory DROP COLUMN IF EXISTS notes;
