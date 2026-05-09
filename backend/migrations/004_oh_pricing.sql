-- OH Pricing — internal valuation table.
-- Pushed weekly (Fridays) by Apps Script from the OH Pricing Google Sheet.
-- Two source sheets: "Gurgaon" → Gurgaon, "Noida + GZB" → Noida + Ghaziabad.

BEGIN;

CREATE TABLE IF NOT EXISTS oh_pricing (
    id              BIGSERIAL PRIMARY KEY,
    source_sheet    TEXT NOT NULL,         -- 'Gurgaon' | 'Noida + GZB' (so we can replace per-sheet)
    city            TEXT NOT NULL,         -- normalized: 'Gurgaon' | 'Noida' | 'Ghaziabad'
    society         TEXT NOT NULL,         -- as appears in sheet
    society_norm    TEXT NOT NULL,         -- LOWER(TRIM(society)), used for lookup
    bhk             INT,                   -- nullable: NULL means "any BHK for this society"
    area_sqft       INT,                   -- nullable: NULL means "any area"
    price           BIGINT NOT NULL,       -- total in ₹
    last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oh_pricing_lookup
    ON oh_pricing (society_norm, bhk, area_sqft);
CREATE INDEX IF NOT EXISTS idx_oh_pricing_city
    ON oh_pricing (city);
CREATE INDEX IF NOT EXISTS idx_oh_pricing_source_sheet
    ON oh_pricing (source_sheet);

COMMIT;
