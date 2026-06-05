-- Migration 019: introduce the `unqualified` intake stage.
--
-- Stage flow:
--   unqualified -> qualified -> {call_not_received, follow_up,
--                                visit_scheduled, rejected}
--   {call_not_received, follow_up} -> {visit_scheduled, rejected}
--
-- `unqualified` is the unacted intake stage — the Leads board's "Unqualified"
-- column. New rows (sheet sync, manual create, raw inserts) land here and are
-- worked forward by an RM. The Python insert paths set stage='unqualified'
-- explicitly; this migration realigns the column DEFAULT so raw inserts agree.
--
-- Existing rows already worked into 'qualified' (or any later stage) keep their
-- stage — only the default for brand-new rows changes. A short-lived earlier
-- revision of this migration defaulted new rows to 'lead'; the UPDATE below
-- renames any such rows to 'unqualified' so the value set is consistent. Safe
-- to re-run.
--
-- Note: `stage` is plain TEXT with no CHECK constraint, so the new stage value
-- needs no enum/constraint change. Reject reasons are likewise plain TEXT and
-- validated in application code only (two context sets: listing-quality reasons
-- for unqualified leads, engagement reasons for worked stages).

ALTER TABLE inventory ALTER COLUMN stage SET DEFAULT 'unqualified';

UPDATE inventory SET stage = 'unqualified' WHERE stage = 'lead';
