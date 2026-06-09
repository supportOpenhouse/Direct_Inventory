-- Migration 026: 'Unallocated' placeholder RM for the auto-assign fallback.
-- Leads that match no real RM (by society / micro-market / city) are assigned
-- to this user instead of being left with no POC, so they surface under a known
-- bucket rather than disappearing from RM-scoped views. It has no city/society/
-- micro scope, so the resolver never auto-matches it — it's used only as the
-- explicit fallback in services/assignment.py. Idempotent.
BEGIN;

INSERT INTO users (email, name, role, is_active)
VALUES ('unallocated@openhouse.in', 'Unallocated', 'rm', TRUE)
ON CONFLICT (email) DO NOTHING;

COMMIT;
