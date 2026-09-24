-- meta_ads_responses — leads captured by the OH Supply Meta lead-ad landing page.
--
-- This table belongs to the landing-page deployment rather than the main app's
-- migration chain, but it lives in the same database (DATABASE_URL). It is
-- written to only by OH-Supply_meta/api/lead.js.
--
-- Idempotent: safe to re-run.
--
-- Apply with:
--     psql "$DATABASE_URL" -f OH-Supply_meta/schema.sql

CREATE TABLE IF NOT EXISTS meta_ads_responses (
    id                  BIGSERIAL PRIMARY KEY,

    -- Lead fields, in the order the form asks for them.
    name                TEXT        NOT NULL,
    phone               TEXT        NOT NULL,       -- E.164, e.g. +919876543210
    email               TEXT,
    city                TEXT        NOT NULL,
    configuration       TEXT        NOT NULL,       -- BHK, e.g. '2 BHK'
    society             TEXT        NOT NULL,
    expected_price_lacs NUMERIC(12, 2),
    consent             BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Provenance.
    source              TEXT        NOT NULL DEFAULT 'meta_lead_ad',
    submitted_at        TIMESTAMPTZ,                -- client clock, as sent
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server clock, authoritative

    -- Meta / campaign attribution, read from the landing URL's query string.
    fbclid              TEXT,
    utm_source          TEXT,
    utm_medium          TEXT,
    utm_campaign        TEXT,
    utm_content         TEXT,
    utm_term            TEXT,
    ad_id               TEXT,
    adset_id            TEXT,
    campaign_id         TEXT,
    landing_url         TEXT
);

-- Newest-first listing, the only read pattern this table has today.
CREATE INDEX IF NOT EXISTS meta_ads_responses_created_at_idx
    ON meta_ads_responses (created_at DESC);

-- De-dupe / lookup by phone when the same person submits twice.
CREATE INDEX IF NOT EXISTS meta_ads_responses_phone_idx
    ON meta_ads_responses (phone);

-- Per-campaign reporting.
CREATE INDEX IF NOT EXISTS meta_ads_responses_campaign_idx
    ON meta_ads_responses (campaign_id)
    WHERE campaign_id IS NOT NULL;

-- Every lead now passes an SMS OTP check before it is written. Kept as a
-- column (not just implied) so a row is self-describing to anyone reading the
-- table later. Added separately so re-running this file on the existing table
-- works.
ALTER TABLE meta_ads_responses
    ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;


-- ---------------------------------------------------------------------------
-- meta_otp_verifications — one row per OTP sent to a phone number.
--
-- Serverless functions share no memory, so the send and the verify almost
-- certainly run on different instances; this table is the only thing both of
-- them can see.
--
-- The code is stored as a SHA-256 hash, never in plaintext: a leaked backup
-- or an over-broad SELECT then can't be used to complete someone's signup.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta_otp_verifications (
    id            BIGSERIAL PRIMARY KEY,
    phone         TEXT        NOT NULL,          -- E.164, matches meta_ads_responses.phone
    code_hash     TEXT        NOT NULL,          -- sha256(code + phone)
    expires_at    TIMESTAMPTZ NOT NULL,
    attempts      SMALLINT    NOT NULL DEFAULT 0,  -- wrong guesses, capped server-side
    verified_at   TIMESTAMPTZ,                   -- set once the right code arrives
    consumed_at   TIMESTAMPTZ,                   -- set when a lead uses it, so it's one-shot
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip            TEXT                           -- rate limiting only
);

-- Verify reads the newest unexpired row for a phone; send counts recent rows
-- for the same number to throttle resends. Both are this index.
CREATE INDEX IF NOT EXISTS meta_otp_verifications_phone_created_idx
    ON meta_otp_verifications (phone, created_at DESC);

-- Resend throttling by IP, to blunt someone burning SMS credit in bulk.
CREATE INDEX IF NOT EXISTS meta_otp_verifications_ip_created_idx
    ON meta_otp_verifications (ip, created_at DESC)
    WHERE ip IS NOT NULL;
