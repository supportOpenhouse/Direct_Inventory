-- Migration 025: merge the legacy 'follow_up_cnr' stage into 'call_not_received'.
-- 'follow_up_cnr' ("Follow Up (CNR)") is a retired stage; it is not in the
-- current pipeline (VALID_STAGES) and only survived as a legacy display label.
-- Fold any remaining rows AND historical activity_log values (before_value /
-- after_value) into 'call_not_received' so the stage disappears from the data
-- and those actions are counted as Call Not Received in the user report
-- (which reads activity_log.after_value). Idempotent; safe to re-run.
BEGIN;

UPDATE inventory SET stage = 'call_not_received' WHERE stage = 'follow_up_cnr';

UPDATE activity_log SET before_value = 'call_not_received'
 WHERE entity_type = 'inventory' AND before_value = 'follow_up_cnr';
UPDATE activity_log SET after_value = 'call_not_received'
 WHERE entity_type = 'inventory' AND after_value = 'follow_up_cnr';

COMMIT;
