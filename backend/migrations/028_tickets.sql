-- 028_tickets.sql — property tickets raised by admin/manager for the assigned RM.
--
-- A ticket is a first-class conversation about one property: the creator
-- (admin/manager) posts a title + summary, the property's assigned RM replies,
-- and the back-and-forth continues until the creator/admin closes it.
--
-- The reply thread lives in the `messages` JSONB array (same shape as
-- inventory.note_thread). `awaiting` tracks whose turn it is, which drives the
-- "needs my action" count (nav dot, Home card, Tickets badge):
--   created -> 'rm'; RM replies -> 'creator'; creator replies -> 'rm'; closed -> NULL.
-- Idempotent: safe to re-run.

-- oh_id is nullable: a ticket can be raised on a property (oh_id set, RM
-- resolved from the property) OR directly to an RM with no property link.
CREATE TABLE IF NOT EXISTS tickets (
  id               BIGSERIAL PRIMARY KEY,
  oh_id            TEXT,
  title            TEXT NOT NULL,
  summary          TEXT,
  status           TEXT NOT NULL DEFAULT 'open',      -- 'open' | 'closed'
  awaiting         TEXT,                              -- 'rm' | 'creator' | NULL when closed
  created_by_id    INT REFERENCES users(id) ON DELETE SET NULL,
  created_by_name  TEXT,
  created_by_email TEXT,
  assigned_rm_id   INT REFERENCES users(id) ON DELETE SET NULL,  -- snapshot of property RM at creation
  city             TEXT,                              -- snapshot for future manager-city scoping
  messages         JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  closed_by_id     INT
);

CREATE INDEX IF NOT EXISTS idx_tickets_oh_id       ON tickets(oh_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_rm ON tickets(assigned_rm_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by  ON tickets(created_by_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status      ON tickets(status);
