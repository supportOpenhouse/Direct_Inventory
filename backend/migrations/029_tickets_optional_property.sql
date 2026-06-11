-- 029_tickets_optional_property.sql — allow tickets without a property link.
--
-- A ticket can now be raised directly to an RM (no oh_id). For databases that
-- already created the tickets table with oh_id NOT NULL (an earlier 028), drop
-- the constraint. Idempotent: dropping NOT NULL twice is a harmless no-op.

ALTER TABLE tickets ALTER COLUMN oh_id DROP NOT NULL;
