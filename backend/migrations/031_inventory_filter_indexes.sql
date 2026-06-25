-- 031_inventory_filter_indexes.sql — indexes for hot inventory filter columns
-- that _build_filters() touches but earlier migrations never covered. All
-- IF NOT EXISTS / idempotent. Plain (non-CONCURRENT) so they run inside the
-- migration runner's transaction; the table is small enough that the brief
-- build lock is a non-issue at this write volume.
--
-- Already covered elsewhere (not repeated): city (001), stage (001),
-- follow_up_at (006), created_at (030), assigned_rm_ids (018), cp_match,
-- priority, star_color, search_tsv GIN.
--
-- NOTE: the free-text `?q=` search uses ILIKE '%token%' across many columns,
-- which a btree can't serve. A pg_trgm GIN index would, but that needs the
-- extension + a query change — left as a separate follow-up.

-- Range filter (posting_from/posting_to), IS NULL preset, and a sortable column.
CREATE INDEX IF NOT EXISTS idx_inventory_posting_date
    ON inventory (posting_date);

-- Equality filter on the Source dropdown.
CREATE INDEX IF NOT EXISTS idx_inventory_source
    ON inventory (source);

-- Equality / ANY() filter — powers the Rejected board's reason filter.
CREATE INDEX IF NOT EXISTS idx_inventory_stage_reason
    ON inventory (stage_reason);

-- BHK filter (bedrooms = ANY(...) / NOT IN standard set).
CREATE INDEX IF NOT EXISTS idx_inventory_bedrooms
    ON inventory (bedrooms);

-- Society / locality filters compare LOWER(TRIM(col)) = ANY(...), so the plain
-- idx_inventory_society can't serve them — these expression indexes match the
-- exact filter form built in _build_filters().
CREATE INDEX IF NOT EXISTS idx_inventory_society_norm
    ON inventory (LOWER(TRIM(society)));

CREATE INDEX IF NOT EXISTS idx_inventory_locality_norm
    ON inventory (LOWER(TRIM(locality)));
