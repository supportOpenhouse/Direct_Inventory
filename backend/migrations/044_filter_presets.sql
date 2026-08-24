-- 044_filter_presets.sql — per-user saved filter presets for the Home board.
--
-- Wide, capped-at-3 shape (as spec'd): one row per user, three preset slots
-- (preset1/2/3, each JSONB {name, filters}). `sequence` is the display order as
-- an array of slot numbers (1..3); `priority` is the slot that auto-applies and
-- is constrained to be FIRST in `sequence` (the extreme-left preset).
CREATE TABLE IF NOT EXISTS filter_presets (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preset1    JSONB,
  preset2    JSONB,
  preset3    JSONB,
  sequence   INTEGER[]   NOT NULL DEFAULT '{}',
  priority   INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Priority preset must be the first element of the sequence array.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'filter_presets_priority_first'
  ) THEN
    ALTER TABLE filter_presets ADD CONSTRAINT filter_presets_priority_first
      CHECK (priority IS NULL OR (array_length(sequence, 1) >= 1 AND sequence[1] = priority));
  END IF;
END $$;
