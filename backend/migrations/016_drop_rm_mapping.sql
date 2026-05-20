-- Migration 016: retire the rm_mapping table.
--
-- RM / manager mapping now lives entirely on the users table:
--   users.cities[]       — cities a user (RM or manager) covers
--   users.society[]      — societies an RM is scoped to  (most specific)
--   users.micro_market[] — micro-markets an RM is scoped to
--
-- Step 1 folds every existing rm_mapping row into those arrays (best effort),
-- Step 2 drops the table. backend/services/assignment.py:resolve_assignment()
-- now reads the users table instead of rm_mapping.
--
-- Mapping carried over:
--   society-level row   -> RM.society[]
--   locality-only row   -> RM.micro_market[]   (locality ~= micro-market)
--   city of every row   -> RM.cities[] and (if set) manager.cities[]
-- NOT carried over: the explicit per-row manager link is collapsed to a
-- city-level association; rebuild finer mapping with the new page.
--
-- Idempotent: safe to run once; re-running after the table is gone is a no-op.

BEGIN;

-- Guard: the app already references these columns, but make sure they exist
-- (and are non-null arrays) for any environment where they were never added.
ALTER TABLE users ADD COLUMN IF NOT EXISTS society      TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS micro_market TEXT[] NOT NULL DEFAULT '{}';

DO $$
DECLARE r RECORD;
BEGIN
    IF to_regclass('public.rm_mapping') IS NULL THEN
        RAISE NOTICE 'rm_mapping already dropped — nothing to migrate.';
        RETURN;
    END IF;

    FOR r IN SELECT * FROM rm_mapping LOOP
        -- City goes to the RM (and the manager, if one was linked).
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

        -- Society-level mapping -> RM.society[]; locality-only -> micro_market[].
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
END $$;

-- Drop the table and its updated_at trigger.
DROP TRIGGER IF EXISTS trg_rm_mapping_updated ON rm_mapping;
DROP TABLE IF EXISTS rm_mapping;

COMMIT;
