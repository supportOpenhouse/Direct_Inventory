-- Add seller contact number and a follow-up date to each inventory row.

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS seller_phone TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS follow_up_at DATE;

CREATE INDEX IF NOT EXISTS idx_inventory_follow_up_at ON inventory(follow_up_at);
