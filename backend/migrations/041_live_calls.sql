-- Live Calls (Phase 5): the RM-facing disposition surface over the auto-dialer.
--
-- A dialer call ends up 'done' on dial_queue (the webhook / poll fallback flips it),
-- but "did the RM actually reach the person?" is a human judgement the RM marks after
-- the call. call_result carries that: NULL = still needs a result (drives the "needs
-- result" badge), 'connected' | 'missed' once marked.
ALTER TABLE dial_queue ADD COLUMN IF NOT EXISTS call_result    TEXT;         -- 'connected' | 'missed' | NULL(=unmarked)
ALTER TABLE dial_queue ADD COLUMN IF NOT EXISTS call_result_at TIMESTAMPTZ;
ALTER TABLE dial_queue ADD COLUMN IF NOT EXISTS call_result_by TEXT;

-- Spam guard: a second "not connected" on the same lead within 2h is refused (no
-- miss_count bump, no note) unless it came from a real dialer call. This tracks the
-- last such "No" so the cooldown can be measured.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_no_timestamp TIMESTAMPTZ;

-- The "my unmarked calls today" badge + snapshot both filter on this.
CREATE INDEX IF NOT EXISTS idx_dial_queue_rm_result
  ON dial_queue(rm_email, dialed_at) WHERE call_result IS NULL;
