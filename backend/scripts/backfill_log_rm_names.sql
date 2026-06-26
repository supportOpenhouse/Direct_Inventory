-- backfill_log_rm_names.sql
-- One-off: rewrite existing activity_log rows so RM / manager values show NAMES
-- instead of ids, while keeping the original ids ON THE ROW ITSELF (in
-- metadata.before_ids / after_ids — exactly what new logs already store). No
-- backup table: each row is self-contained and reversible from its own metadata.
--
--   assigned_rm_ids  "[38]"      -> "[Animesh Singh]"   metadata.before_ids/after_ids = [..]
--   assigned_rm_ids  "[38, 40]"  -> "[Animesh Singh, Aman Dixit]"
--   assigned_rm_ids  "[]"        -> "[]"   (ids = [])
--   assigned_mgr_id  "16"        -> "Big Boss"          ids = [16]
--   manager          "16"        -> "Big Boss"          ids = [16]
--
-- Names + ids are computed from the ORIGINAL column values in one UPDATE, so the
-- ids are captured before the value is overwritten. Deleted users fall back to
-- "#<id>". Idempotent: a converted value no longer matches the id pattern, so
-- re-running is a no-op. Verify inside the transaction (preview SELECT) and
-- COMMIT, or ROLLBACK if anything looks off — nothing persists until COMMIT.

BEGIN;

-- 1) assigned_rm_ids (array): "[id, id]" -> "[Name, Name]", original ids -> metadata.
UPDATE activity_log a
SET
    before_value = CASE
        WHEN a.before_value ~ '^\[[0-9]+(\s*,\s*[0-9]+)*\]$' THEN (
            SELECT '[' || string_agg(
                            COALESCE(NULLIF(TRIM(u.name), ''), u.email, '#' || s.tok),
                            ', ' ORDER BY s.ord
                          ) || ']'
            FROM regexp_split_to_table(btrim(a.before_value, '[]'), '\s*,\s*')
                 WITH ORDINALITY AS s(tok, ord)
            LEFT JOIN users u ON u.id = s.tok::int)
        ELSE a.before_value END,
    after_value = CASE
        WHEN a.after_value ~ '^\[[0-9]+(\s*,\s*[0-9]+)*\]$' THEN (
            SELECT '[' || string_agg(
                            COALESCE(NULLIF(TRIM(u.name), ''), u.email, '#' || s.tok),
                            ', ' ORDER BY s.ord
                          ) || ']'
            FROM regexp_split_to_table(btrim(a.after_value, '[]'), '\s*,\s*')
                 WITH ORDINALITY AS s(tok, ord)
            LEFT JOIN users u ON u.id = s.tok::int)
        ELSE a.after_value END,
    metadata = COALESCE(a.metadata, '{}'::jsonb) || jsonb_build_object(
        'before_ids', COALESCE((SELECT jsonb_agg(s.tok::int ORDER BY s.ord)
                                FROM regexp_split_to_table(btrim(a.before_value, '[]'), '\s*,\s*')
                                     WITH ORDINALITY AS s(tok, ord)
                                WHERE s.tok ~ '^[0-9]+$'), '[]'::jsonb),
        'after_ids',  COALESCE((SELECT jsonb_agg(s.tok::int ORDER BY s.ord)
                                FROM regexp_split_to_table(btrim(a.after_value, '[]'), '\s*,\s*')
                                     WITH ORDINALITY AS s(tok, ord)
                                WHERE s.tok ~ '^[0-9]+$'), '[]'::jsonb))
WHERE a.field = 'assigned_rm_ids'
  AND (a.before_value ~ '^\[[0-9]+(\s*,\s*[0-9]+)*\]$'
       OR a.after_value ~ '^\[[0-9]+(\s*,\s*[0-9]+)*\]$');

-- 2) assigned_mgr_id / manager (scalar): "16" -> "Big Boss", original id -> metadata.
UPDATE activity_log a
SET
    before_value = CASE
        WHEN a.before_value ~ '^[0-9]+$' THEN
            COALESCE((SELECT COALESCE(NULLIF(TRIM(u.name), ''), u.email)
                      FROM users u WHERE u.id = a.before_value::int),
                     '#' || a.before_value)
        ELSE a.before_value END,
    after_value = CASE
        WHEN a.after_value ~ '^[0-9]+$' THEN
            COALESCE((SELECT COALESCE(NULLIF(TRIM(u.name), ''), u.email)
                      FROM users u WHERE u.id = a.after_value::int),
                     '#' || a.after_value)
        ELSE a.after_value END,
    metadata = COALESCE(a.metadata, '{}'::jsonb) || jsonb_build_object(
        'before_ids', CASE WHEN a.before_value ~ '^[0-9]+$'
                           THEN jsonb_build_array(a.before_value::int) ELSE '[]'::jsonb END,
        'after_ids',  CASE WHEN a.after_value ~ '^[0-9]+$'
                           THEN jsonb_build_array(a.after_value::int) ELSE '[]'::jsonb END)
WHERE a.field IN ('assigned_mgr_id', 'manager')
  AND (a.before_value ~ '^[0-9]+$' OR a.after_value ~ '^[0-9]+$');

-- Preview before committing (optional):
--   SELECT id, field, before_value, after_value, metadata FROM activity_log
--   WHERE field IN ('assigned_rm_ids','assigned_mgr_id','manager')
--   ORDER BY id DESC LIMIT 20;

COMMIT;

-- Reversible from the row itself (no side table) — the original ids live in
-- metadata.before_ids / after_ids on each converted row.
