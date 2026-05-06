-- Direct Inventory Portal — initial schema
-- Migration 001: tables, indexes, OH-ID counter

BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id           SERIAL PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    name         TEXT,
    phone        TEXT,
    role         TEXT NOT NULL,                       -- 'admin' | 'manager' | 'rm'
    cities       TEXT[] NOT NULL DEFAULT '{}',        -- e.g. {'Noida','Gurgaon'}
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_cities ON users USING GIN (cities);

-- RM/Manager mapping. Society is optional — match by city + locality (+ society if set).
-- Resolution order: society > locality > city. First matching row wins.
CREATE TABLE IF NOT EXISTS rm_mapping (
    id            SERIAL PRIMARY KEY,
    city          TEXT NOT NULL,
    locality      TEXT,            -- nullable: city-wide fallback
    society       TEXT,            -- nullable: locality-wide fallback
    rm_user_id    INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    manager_user_id INT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_mapping_lookup ON rm_mapping(city, locality, society);

-- Per-city OH-ID counter. counter goes 1..9999, then suffix moves '' -> 'A' -> 'B' ...
CREATE TABLE IF NOT EXISTS oh_id_counter (
    city_code   TEXT PRIMARY KEY,    -- 'G' | 'N' | 'GH'
    counter     INT  NOT NULL DEFAULT 0,
    suffix      TEXT NOT NULL DEFAULT ''
);

INSERT INTO oh_id_counter (city_code) VALUES ('G'), ('N'), ('GH')
ON CONFLICT (city_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS inventory (
    id              SERIAL PRIMARY KEY,
    oh_id           TEXT NOT NULL UNIQUE,             -- e.g. 'OHLND0001'
    -- Raw fields from sheet (source of truth lives in Google Sheet)
    source          TEXT,                             -- '99acres' | 'magicbricks' | 'manual' | ...
    city            TEXT NOT NULL,                    -- 'Noida' | 'Gurgaon' | 'Ghaziabad' (or 'Greater Noida' etc.)
    locality        TEXT,
    society         TEXT,
    bedrooms        INT,
    area_sqft       INT,
    floor           TEXT,                             -- string: handles 'G', '15', 'PH'
    price           BIGINT,                           -- in INR (integer)
    seller_name     TEXT,
    posting_date    DATE,
    listing_link    TEXT NOT NULL UNIQUE,             -- dedup key

    -- Workflow fields (owned by this app)
    stage           TEXT NOT NULL DEFAULT 'qualified',
    reject_reason   TEXT,                             -- only set when stage='rejected'
    notes           TEXT,
    assigned_rm_id  INT REFERENCES users(id) ON DELETE SET NULL,
    assigned_mgr_id INT REFERENCES users(id) ON DELETE SET NULL,

    -- Visit linkage (Forms app)
    forms_visit_id  TEXT,                             -- ID returned by Forms app
    visit_at        TIMESTAMPTZ,
    visit_exec      TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at  TIMESTAMPTZ                        -- last time sheet sync touched this row
);

CREATE INDEX IF NOT EXISTS idx_inventory_stage         ON inventory(stage);
CREATE INDEX IF NOT EXISTS idx_inventory_city          ON inventory(city);
CREATE INDEX IF NOT EXISTS idx_inventory_assigned_rm   ON inventory(assigned_rm_id);
CREATE INDEX IF NOT EXISTS idx_inventory_assigned_mgr  ON inventory(assigned_mgr_id);
CREATE INDEX IF NOT EXISTS idx_inventory_society       ON inventory(society);
CREATE INDEX IF NOT EXISTS idx_inventory_listing_link  ON inventory(listing_link);

-- Full-text search column. Updated by trigger on insert/update.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION inventory_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', COALESCE(NEW.oh_id, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.society, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.seller_name, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.locality, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.city, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.source, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.listing_link, '')), 'D') ||
        setweight(to_tsvector('simple', COALESCE(NEW.notes, '')), 'D');
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_search ON inventory;
CREATE TRIGGER trg_inventory_search BEFORE INSERT OR UPDATE
    ON inventory FOR EACH ROW EXECUTE FUNCTION inventory_search_trigger();

CREATE INDEX IF NOT EXISTS idx_inventory_search_tsv ON inventory USING GIN (search_tsv);

-- Activity log: every meaningful click/edit. Append-only.
CREATE TABLE IF NOT EXISTS activity_log (
    id            BIGSERIAL PRIMARY KEY,
    actor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
    actor_email   TEXT,                              -- denormalized for quick lookup
    entity_type   TEXT NOT NULL,                     -- 'inventory' | 'rm_mapping' | 'user' | 'auth' | 'sync'
    entity_id     TEXT,                              -- usually inventory.oh_id, but text for flexibility
    action        TEXT NOT NULL,                     -- 'create' | 'update' | 'stage_change' | 'note' | 'assign' | 'login' | 'sync_run' | ...
    field         TEXT,                              -- when action='update', which field changed
    before_value  TEXT,
    after_value   TEXT,
    metadata      JSONB,                             -- ip, user_agent, request_id, batch info, etc.
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor  ON activity_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);

-- updated_at auto-bump
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated      ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_rm_mapping_updated ON rm_mapping;
CREATE TRIGGER trg_rm_mapping_updated BEFORE UPDATE ON rm_mapping
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_inventory_updated  ON inventory;
CREATE TRIGGER trg_inventory_updated BEFORE UPDATE ON inventory
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
