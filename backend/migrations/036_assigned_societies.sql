-- 036_assigned_societies.sql — cache each user's full society coverage.
-- assigned_societies = direct society picks ∪ every society in their
-- micro-markets ∪ every society in their cities (per master_societies).
-- Populated by services.society_scope.recompute_assigned_societies (cross-DB,
-- so not backfilled here) and refreshed on every user-scope edit. Lets the
-- "Clashed Societies" view find societies covered by more than one RM cheaply.
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_societies TEXT[] NOT NULL DEFAULT '{}';
