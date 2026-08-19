-- Incoming-call acknowledgement. An inbound Bonvoice call (a lead ringing the DID →
-- routed to the RM) surfaces as a top-bar notification until the RM acknowledges it.
-- `acknowledged` is the per-call read flag; only meaningful for incoming rows.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT FALSE;

-- Fast lookup of a user's unacknowledged incoming calls (the notification poll).
CREATE INDEX IF NOT EXISTS idx_call_logs_incoming_unack
  ON call_logs(direction) WHERE acknowledged = FALSE;
