-- Bonvoice call log — one row per call LEG, built up by the callback.
-- Bonvoice fires 0 initiated / 1 answered / 2 hangup per leg (up to six callbacks
-- per conversation), upserting on (call_id, leg); COALESCE-per-column and OR-ed
-- `answered` make duplicate/out-of-order deliveries converge on one row.
--
-- oh_id comes from callBackParams (we echo it when placing the call), so logs
-- attach by explicit id, not a phone match. No FK — a log must never fail to write.
CREATE TABLE IF NOT EXISTS call_logs (
    call_id            TEXT NOT NULL,
    leg                TEXT NOT NULL,                -- 'A' caller (RM) | 'B' callee (lead)
    event_id           TEXT,
    oh_id              TEXT,                         -- inventory.oh_id from callBackParams
    campaign_id        TEXT,                         -- dial campaign (Phase 4); NULL = click-to-call
    direction          TEXT,
    source_number      TEXT,
    destination_number TEXT,
    display_number     TEXT,
    status             TEXT,                         -- callee status
    agent_status       TEXT,                         -- caller status (outbound)
    answered           BOOLEAN NOT NULL DEFAULT FALSE,
    start_at           TIMESTAMPTZ,
    end_at             TIMESTAMPTZ,
    recording_url      TEXT,
    placed_by          TEXT,                         -- portal user who dialled (dialer sets it directly)
    raw                JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (call_id, leg)
);
CREATE INDEX IF NOT EXISTS idx_call_logs_event_id   ON call_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_oh_id      ON call_logs(oh_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_campaign   ON call_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_created_at ON call_logs(created_at DESC);
