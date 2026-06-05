-- New lead flow & nomenclature: rename the intake stage 'unqualified' -> 'lead'
-- and introduce 'active' (a lead being worked) between lead and qualified.
--   lead -> active -> qualified -> {call_not_received, follow_up, visit_scheduled, rejected}
-- New rows default to 'lead'. 'active' rows are created by the app (Leads page),
-- so no data backfill is needed for it. Idempotent.
UPDATE inventory SET stage = 'lead' WHERE stage = 'unqualified';
ALTER TABLE inventory ALTER COLUMN stage SET DEFAULT 'lead';
