-- Add tower + unit_no to inventory so we can match a Direct Inventory row
-- against a CP Inventory Portal submission on (society, BHK, floor, tower, unit_no)
-- for the "perfect match" gold star. The partial match (society + BHK + floor)
-- works on existing data; perfect match only kicks in once these are populated.
--
-- Sources for these fields:
--   - Sheet sync: pulled if the daily sheet has tower / unit_no columns;
--     otherwise left NULL (no error).
--   - Manual entry: admins/managers/RMs can fill them in via the detail modal
--     and the Add Inventory modal.

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS tower   TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS unit_no TEXT;
