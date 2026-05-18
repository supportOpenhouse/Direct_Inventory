-- Manual star color override picked by admin / manager from the card-detail
-- modal. Values:
--   'red'    -> force red star
--   'green'  -> force green star
--   'yellow' -> force yellow star (also flips `priority` TRUE so existing sort
--               and filter behaviour keeps working)
--   'none'   -> force blank (suppresses the auto-shown priority / cp_match star)
--   NULL     -> no override; fall back to existing rules:
--               priority -> yellow, cp_match='perfect' -> green,
--               cp_match='partial' -> red, else blank.
--
-- The underlying `priority` (BOOLEAN) and `cp_match` (TEXT) columns are kept
-- intact — they still drive sort order, filtering, and the CP-scan workflow.

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS star_color TEXT;

ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_star_color_chk;
ALTER TABLE inventory ADD CONSTRAINT inventory_star_color_chk
  CHECK (star_color IS NULL OR star_color IN ('red', 'green', 'yellow', 'none'));

CREATE INDEX IF NOT EXISTS idx_inventory_star_color
  ON inventory(star_color) WHERE star_color IS NOT NULL;
