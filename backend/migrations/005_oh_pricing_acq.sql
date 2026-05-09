-- OH Pricing: capture the Acquisition Price column alongside selling price.
-- Sourced from "★ Acq Price (₹L)" on the Gurgaon tab and "L2 Acq (₹L)" on the Noida + GZB tab.

ALTER TABLE oh_pricing ADD COLUMN IF NOT EXISTS acq_price BIGINT;
