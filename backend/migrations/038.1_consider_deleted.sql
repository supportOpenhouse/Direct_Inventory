-- Soft delete. `consider_deleted = TRUE` takes a lead out of the product
-- entirely: every scoped query (see inventory._scope_clause), the Home
-- summaries, the user reports and the background jobs skip it. It stays
-- readable through GET /api/inventory/<oh_id> only, which is what the
-- activity-log UID link opens — that popup reports its stage as 'deleted'
-- and frames itself in a dashed red border.
--
-- The original `stage` is left untouched so the flag is reversible; 'deleted'
-- is derived on read, never stored.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS consider_deleted BOOLEAN NOT NULL DEFAULT FALSE;
