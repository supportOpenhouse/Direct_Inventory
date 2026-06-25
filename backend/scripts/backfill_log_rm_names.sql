-- backfill_log_rm_names.sql
-- One-off: rewrite existing activity_log rows for field='assigned_rm_ids' so the
-- before/after values show RM NAMES instead of ids, e.g.  "[38]" -> "[Animesh
-- Singh]",  "[38, 40]" -> "[Animesh Singh, Aman Dixit]",  "[]" stays "[]".
--
-- Matches the going-forward behaviour in services/activity.py. Scoped to
-- assigned_rm_ids only (mgr fields untouched). Idempotent: once a value is
-- names it no longer matches the id-array pattern, so re-running is a no-op.
-- Safe to run inside this transaction; the backup table lets you roll back even
-- after COMMIT. Run against DATABASE_URL (psql or any client).

BEGIN;

-- 1) Backup the original values (rollback source). IF NOT EXISTS so a re-run
--    keeps the FIRST run's originals rather than overwriting them.
CREATE TABLE IF NOT EXISTS activity_log_rm_names_backup AS
SELECT id, before_value, after_value
FROM activity_log
WHERE field = 'assigned_rm_ids';

-- 2) before_value: "[id, id]" -> "[Name, Name]" (order preserved, deleted users
--    fall back to "#<id>"). The regex guard means only un-converted id arrays
--    with >=1 id are touched; "[]" and already-named values are skipped.
UPDATE activity_log a
SET before_value = (
    SELECT '[' || string_agg(
                    COALESCE(NULLIF(TRIM(u.name), ''), u.email, '#' || s.tok),
                    ', ' ORDER BY s.ord
                  ) || ']'
    FROM regexp_split_to_table(btrim(a.before_value, '[]'), '\s*,\s*')
         WITH ORDINALITY AS s(tok, ord)
    LEFT JOIN users u ON u.id = s.tok::int
)
WHERE a.field = 'assigned_rm_ids'
  AND a.before_value ~ '^\[[0-9]+(\s*,\s*[0-9]+)*\]$';

-- 3) after_value: same transform.
UPDATE activity_log a
SET after_value = (
    SELECT '[' || string_agg(
                    COALESCE(NULLIF(TRIM(u.name), ''), u.email, '#' || s.tok),
                    ', ' ORDER BY s.ord
                  ) || ']'
    FROM regexp_split_to_table(btrim(a.after_value, '[]'), '\s*,\s*')
         WITH ORDINALITY AS s(tok, ord)
    LEFT JOIN users u ON u.id = s.tok::int
)
WHERE a.field = 'assigned_rm_ids'
  AND a.after_value ~ '^\[[0-9]+(\s*,\s*[0-9]+)*\]$';

-- Preview before committing (optional): SELECT id, before_value, after_value
--   FROM activity_log WHERE field='assigned_rm_ids' ORDER BY id DESC LIMIT 20;

COMMIT;

-- Rollback after commit, if ever needed:
--   UPDATE activity_log a SET before_value = b.before_value, after_value = b.after_value
--   FROM activity_log_rm_names_backup b WHERE b.id = a.id;
--   DROP TABLE activity_log_rm_names_backup;
