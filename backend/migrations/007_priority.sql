-- Lets a Manager / Admin flag a lead as Priority so it floats to the top of
-- every kanban column and can be filtered to.
-- RMs cannot set this flag (enforced in code, not via a constraint).

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS priority BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_inventory_priority ON inventory(priority) WHERE priority = TRUE;
