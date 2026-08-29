-- 045_drop_frozen_columns.sql — drop two long-frozen `inventory` columns.
--
-- Both were superseded years ago and are no longer read or written by the app:
--   * assigned_rm_id (single INT)  → replaced by assigned_rm_ids INT[]  (018_multi_rm)
--   * notes          (single TEXT) → replaced by note_thread JSONB      (017_note_thread)
--
-- ⚠️ ORDER MATTERS: the BEFORE INSERT/UPDATE search trigger (inventory_search_trigger,
-- 001_init) still weaves NEW.notes into search_tsv. Dropping `notes` without first
-- redefining that function makes EVERY inventory insert/update fail at runtime
-- ("record new has no field notes") — which 500s visit scheduling, stage changes,
-- everything. So we redefine the trigger FIRST (minus the dead notes line — the
-- column was empty/superseded, so search loses nothing), THEN drop the columns.
--
-- Idempotent: CREATE OR REPLACE + DROP COLUMN IF EXISTS. Safe to (re-)run — if an
-- earlier version of this file already dropped the columns and left the trigger
-- broken, just re-running this repairs the trigger. Destructive (drops old column
-- data) — review before running.

CREATE OR REPLACE FUNCTION inventory_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', COALESCE(NEW.oh_id, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.society, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.seller_name, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.locality, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.city, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.source, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.listing_link, '')), 'D');
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

ALTER TABLE inventory DROP COLUMN IF EXISTS assigned_rm_id;
ALTER TABLE inventory DROP COLUMN IF EXISTS notes;
