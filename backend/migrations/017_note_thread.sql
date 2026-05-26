-- Notes thread: multi-author, append-only list of comments per inventory row.
-- Replaces the single-text `notes` column for live use. The old `notes` column
-- is left in place (untouched) so existing data can be manually transferred
-- into the new thread structure; the app code no longer reads or writes it.
--
-- Each note in the JSONB array:
--   {
--     "id":           "<uuid>",
--     "author_id":    <users.id>,
--     "author_name":  "<full name>",
--     "author_email": "<email>",
--     "body":         "<comment text>",
--     "created_at":   "<ISO-8601 UTC>"
--   }
--
-- Safe to re-run.

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS note_thread JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_inventory_note_thread
  ON inventory USING GIN (note_thread);
