-- Auto-dialer: campaigns compile a rule tree into a per-lead queue, and a background
-- worker rings every RM in the pool who isn't already on a call. See services/dialer.py.
--
-- Our "lead" is an inventory row keyed by oh_id; assignment is inventory.assigned_rm_ids
-- (INT[] of users.id), so the 'assigned' strategy stamps each queue row with the RM it
-- already belongs to — no free-text name matching (unlike the reference).

CREATE TABLE IF NOT EXISTS dial_campaigns (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    rules            JSONB NOT NULL,                  -- the AND/OR condition tree (compiled server-side)
    rms              JSONB NOT NULL DEFAULT '[]',     -- RM emails doing the calling
    strategy         TEXT NOT NULL DEFAULT 'round_robin',  -- round_robin | least_load | assigned
    gap_seconds      INT NOT NULL DEFAULT 0,          -- pause between an RM's calls
    window_start     TEXT NOT NULL DEFAULT '10:00',   -- IST calling hours, HH:MM
    window_end       TEXT NOT NULL DEFAULT '19:00',
    max_attempts     INT NOT NULL DEFAULT 1,          -- redial a lead that rang out, up to this
    cooldown_minutes INT NOT NULL DEFAULT 180,        -- wait this long before a redial
    status           TEXT NOT NULL DEFAULT 'draft',   -- draft | running | paused | done
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dial_queue (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES dial_campaigns(id) ON DELETE CASCADE,
    oh_id       TEXT NOT NULL REFERENCES inventory(oh_id) ON DELETE CASCADE,
    position    BIGINT,                               -- dial order (newest leads first)
    status      TEXT NOT NULL DEFAULT 'pending',      -- pending | dialing | done | failed | skipped
    rm_email    TEXT,                                 -- who claimed it (or the pre-stamped owner)
    event_id    TEXT,                                 -- Bonvoice bridge event; links the hangup callback back
    outcome     TEXT,                                 -- Bonvoice status text
    detail      TEXT,                                 -- why it failed/skipped (human-readable)
    attempts    INT NOT NULL DEFAULT 0,
    answered    BOOLEAN NOT NULL DEFAULT FALSE,
    dialed_at   TIMESTAMPTZ,
    ended_at    TIMESTAMPTZ,
    UNIQUE (campaign_id, oh_id)                       -- one slot per lead; re-materialize is idempotent
);
CREATE INDEX IF NOT EXISTS idx_dial_queue_campaign_status ON dial_queue(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_dial_queue_event_id        ON dial_queue(event_id);
CREATE INDEX IF NOT EXISTS idx_dial_queue_rm_email        ON dial_queue(rm_email);

-- Dialer rule fields + the Live Calls "missed" counter (Phase 5 marks these).
-- miss_count: consecutive rings that never connected. ever_connected: has any call
-- to this lead ever answered. Both filterable in the campaign builder.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS miss_count     INT NOT NULL DEFAULT 0;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS ever_connected BOOLEAN NOT NULL DEFAULT FALSE;
