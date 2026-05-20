-- Migration 016: retire the rm_mapping table.
--
-- RM / manager mapping now lives entirely on the users table:
--   users.cities[]       — cities a user (RM or manager) covers
--   users.society[]      — societies an RM is scoped to  (most specific)
--   users.micro_market[] — micro-markets an RM is scoped to
--   users.manager        — FK to users(id): the RM's reporting manager
--
-- Step 1 folds every existing rm_mapping row into those columns, Step 2 drops
-- the table. backend/services/assignment.py:resolve_assignment() now reads the
-- users table instead of rm_mapping.
--
-- Mapping carried over:
--   society-level row     -> RM.society[]
--   locality-only row     -> RM.micro_market[]   (locality ~= micro-market)
--   city of every row     -> RM.cities[] and (if set) manager.cities[]
--   rm -> manager link    -> RM.manager  (most frequent manager if an RM had
--                                         several mapping rows)
--
-- Idempotent: safe to run once; re-running after the table is gone is a no-op.

BEGIN;

-- New columns on users. Guarded with IF NOT EXISTS — society/micro_market are
-- already referenced by the app; manager is new here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS society      TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS micro_market TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager      INT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager);

DO $$
DECLARE r RECORD;
BEGIN
    IF to_regclass('public.rm_mapping') IS NULL THEN
        RAISE NOTICE 'rm_mapping already dropped — nothing to migrate.';
        RETURN;
    END IF;

    -- City / society / micro-market arrays.
    FOR r IN SELECT * FROM rm_mapping LOOP
        UPDATE users
           SET cities = ARRAY(SELECT DISTINCT e
                              FROM unnest(COALESCE(cities, '{}') || r.city) e)
         WHERE id = r.rm_user_id;
        IF r.manager_user_id IS NOT NULL THEN
            UPDATE users
               SET cities = ARRAY(SELECT DISTINCT e
                                  FROM unnest(COALESCE(cities, '{}') || r.city) e)
             WHERE id = r.manager_user_id;
        END IF;

        IF r.society IS NOT NULL THEN
            UPDATE users
               SET society = ARRAY(SELECT DISTINCT e
                                   FROM unnest(COALESCE(society, '{}') || r.society) e)
             WHERE id = r.rm_user_id;
        ELSIF r.locality IS NOT NULL THEN
            UPDATE users
               SET micro_market = ARRAY(SELECT DISTINCT e
                                        FROM unnest(COALESCE(micro_market, '{}') || r.locality) e)
             WHERE id = r.rm_user_id;
        END IF;
    END LOOP;

    -- RM -> manager link. If an RM had several mapping rows, the most frequent
    -- manager wins (manager_user_id as a stable tie-break).
    UPDATE users u
       SET manager = ranked.manager_user_id
      FROM (
          SELECT rm_user_id, manager_user_id,
                 ROW_NUMBER() OVER (
                     PARTITION BY rm_user_id
                     ORDER BY COUNT(*) DESC, manager_user_id
                 ) AS rn
          FROM rm_mapping
          WHERE manager_user_id IS NOT NULL
          GROUP BY rm_user_id, manager_user_id
      ) ranked
     WHERE u.id = ranked.rm_user_id
       AND ranked.rn = 1;
END $$;

-- Drop the table and its updated_at trigger.
DROP TRIGGER IF EXISTS trg_rm_mapping_updated ON rm_mapping;
DROP TABLE IF EXISTS rm_mapping;

COMMIT;
