-- Multi-manager: convert users.manager (INT FK → one manager) into
-- users.manager_ids (INT[] → many managers per RM).
--
-- Existing values become one-element arrays; NULL stays NULL. No data is lost.
-- Idempotent: the guard tests for the OLD column name, which the rename at the end
-- removes, so re-running is a no-op.
--
-- Trade-off: an array can't carry a per-element FK, so referential integrity for the
-- manager ids is now enforced in the application (see api/users.py write path). We treat
-- NULL and '{}' as identical ("no managers") — read code normalizes with `or []`.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'manager'
    ) THEN
        -- A single-column FK cannot survive the array conversion.
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_manager_fkey;

        ALTER TABLE users
            ALTER COLUMN manager TYPE integer[]
            USING CASE WHEN manager IS NULL THEN NULL ELSE ARRAY[manager] END;

        ALTER TABLE users RENAME COLUMN manager TO manager_ids;

        -- The old btree (idx_users_manager) survives the rename but is useless for
        -- `%s = ANY(manager_ids)` membership. Swap it for a GIN index, which is.
        DROP INDEX IF EXISTS idx_users_manager;
        CREATE INDEX IF NOT EXISTS idx_users_manager_ids ON users USING GIN (manager_ids);
    END IF;
END $$;
