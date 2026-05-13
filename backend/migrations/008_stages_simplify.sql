-- Stages refactor: drop Visit Completed / Offer Given / Unreachable tabs from
-- the board and split the old "Follow Up (CNR)" into two distinct stages:
--   call_not_received  (CNR — first attempt failed)
--   follow_up          (ongoing conversation)
--
-- Migrate existing rows: every `follow_up_cnr` row becomes `call_not_received`
-- (closer to the original meaning of CNR).
--
-- Rows currently in visit_completed / offer_given / unreachable keep their
-- stage value but stop appearing on the kanban (they're no longer in the
-- frontend STAGES array). VALID_STAGES on the backend still accepts the
-- legacy values so the Forms webhook (POST /api/visits/forms-webhook) keeps
-- working — a completed visit will still flip to `visit_completed`, it just
-- won't show on the board.
--
-- activity_log entries are intentionally NOT rewritten — they're historical
-- and the old slug `follow_up_cnr` is preserved in the frontend stageLabel
-- map so old entries still render with their original name.

UPDATE inventory SET stage = 'call_not_received' WHERE stage = 'follow_up_cnr';
