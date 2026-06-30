-- 034_job_runs.sql — last-run timestamps for throttled jobs. Currently powers
-- the cooldown on the manual "assign missing" button (Track Tasks), so the heavy
-- scan can't be spammed on top of the 15-min cron. Idempotent.
CREATE TABLE IF NOT EXISTS job_runs (
  job          TEXT PRIMARY KEY,
  last_run_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
