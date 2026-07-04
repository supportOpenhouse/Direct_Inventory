-- 035_single_rm_cleanup.sql — multi-RM support removed; collapse any lead that
-- currently holds more than one RM down to a single RM. Only touches leads with
-- >1 RM, so single-RM and unassigned leads (incl. deliberate manual picks) are
-- left alone. Keeps the FIRST RM in the array and re-derives the manager from
-- it. Idempotent: after this, no row has cardinality > 1, so a re-run is a no-op.
UPDATE inventory i
SET assigned_rm_ids = i.assigned_rm_ids[1:1],
    assigned_mgr_id = (SELECT u.manager FROM users u WHERE u.id = i.assigned_rm_ids[1])
WHERE cardinality(i.assigned_rm_ids) > 1;
