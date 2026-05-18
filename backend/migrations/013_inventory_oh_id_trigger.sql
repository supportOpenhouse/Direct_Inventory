-- Auto-assign oh_id on INSERT into inventory.
--
-- Defense in depth: every insert path (manual create, sheet sync, future bulk
-- imports, raw SQL) gets a city-aware oh_id. The trigger is a no-op when
-- oh_id is already set on the incoming row, so the existing Python
-- next_oh_id() calls in backend/services/oh_id.py keep working unchanged.
--
-- Uniqueness: inventory.oh_id has UNIQUE from 001_init.sql. The DO block
-- below re-asserts it defensively so this migration is idempotent on any DB.

-- 1. Re-assert UNIQUE on inventory.oh_id if it's somehow missing.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'inventory'
          AND c.contype = 'u'
          AND EXISTS (
              SELECT 1 FROM unnest(c.conkey) AS k
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k
              WHERE a.attname = 'oh_id'
          )
    ) THEN
        ALTER TABLE inventory ADD CONSTRAINT inventory_oh_id_key UNIQUE (oh_id);
    END IF;
END $$;

-- 2. Trigger function: city-aware oh_id allocation.
CREATE OR REPLACE FUNCTION assign_inventory_oh_id() RETURNS TRIGGER AS $$
DECLARE
    code     TEXT;
    new_cnt  INT;
    new_sfx  TEXT;
BEGIN
    -- No-op when caller already assigned an oh_id (Python next_oh_id path).
    IF NEW.oh_id IS NOT NULL AND NEW.oh_id <> '' THEN
        RETURN NEW;
    END IF;

    IF NEW.city IS NULL OR TRIM(NEW.city) = '' THEN
        RAISE EXCEPTION 'inventory insert missing city — cannot assign oh_id';
    END IF;

    -- Mirrors CITY_TO_CODE in backend/services/oh_id.py. Keep in sync.
    code := CASE LOWER(TRIM(NEW.city))
        WHEN 'noida'         THEN 'N'
        WHEN 'greater noida' THEN 'N'
        WHEN 'gurgaon'       THEN 'G'
        WHEN 'gurugram'      THEN 'G'
        WHEN 'ghaziabad'     THEN 'GH'
        ELSE NULL
    END;
    IF code IS NULL THEN
        RAISE EXCEPTION 'unknown city for oh_id: %', NEW.city;
    END IF;

    -- Serialize concurrent inserts via row lock on the per-city counter.
    SELECT counter, suffix INTO new_cnt, new_sfx
    FROM oh_id_counter
    WHERE city_code = code
    FOR UPDATE;

    IF new_cnt IS NULL THEN
        RAISE EXCEPTION 'oh_id_counter row missing for city_code=% — run migrations', code;
    END IF;

    new_cnt := new_cnt + 1;
    IF new_cnt > 9999 THEN
        new_cnt := 1;
        new_sfx := CASE
            WHEN new_sfx = ''            THEN 'A'
            WHEN new_sfx = 'Z'           THEN 'AA'
            WHEN new_sfx ~ '^[A-Y]$'     THEN CHR(ASCII(new_sfx) + 1)
            ELSE new_sfx
        END;
    END IF;

    UPDATE oh_id_counter
    SET counter = new_cnt, suffix = new_sfx
    WHERE city_code = code;

    NEW.oh_id := 'OHL' || code || 'D' || LPAD(new_cnt::TEXT, 4, '0') || new_sfx;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Wire trigger on inventory. DROP+CREATE keeps migration idempotent.
DROP TRIGGER IF EXISTS inventory_assign_oh_id ON inventory;
CREATE TRIGGER inventory_assign_oh_id
    BEFORE INSERT ON inventory
    FOR EACH ROW
    EXECUTE FUNCTION assign_inventory_oh_id();
