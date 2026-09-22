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
