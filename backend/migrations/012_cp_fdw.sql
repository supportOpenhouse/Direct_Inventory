-- Postgres FDW setup for the CP database.
--
-- The CP Inventory Portal's `submissions` table lives in a separate Neon DB
-- (see CP_DB_URL env var). With this migration applied, the Direct DB can
-- query it as a foreign table named `cp_submissions`, which lets the
-- cp_match scan run as a single in-DB SQL UPDATE instead of a chunked
-- Python loop with per-chunk cross-DB round-trips.
--
-- HOW TO APPLY:
--   Run this against the DIRECT (Neon) DB. Before applying:
--     1. Replace <CP_PASSWORD> with the real CP DB password from
--        the CP_DB_URL env var on Render.
--     2. Verify host/port/dbname/user match your CP_DB_URL.
--
-- After applying, sanity-check with:
--     SELECT count(*) FROM cp_submissions;

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- CASCADE so a partial / earlier setup is cleanly replaced.
DROP SERVER IF EXISTS cp_db_server CASCADE;

CREATE SERVER cp_db_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (
    host 'ep-plain-brook-aol6mi37-pooler.c-2.ap-southeast-1.aws.neon.tech',
    port '5432',
    dbname 'neondb',
    sslmode 'require'
  );

-- Map the Direct DB user to the CP DB read user. The CASCADE above will
-- have dropped any prior mapping, so this is always a fresh CREATE.
CREATE USER MAPPING FOR CURRENT_USER
  SERVER cp_db_server
  OPTIONS (user 'neondb_owner', password '<CP_PASSWORD>');

-- Only the columns the cp_match scan actually needs. The real `submissions`
-- table has 45+ columns; pulling them all across the wire is wasteful.
CREATE FOREIGN TABLE cp_submissions (
  id            INTEGER,
  society_name  VARCHAR(200),
  tower         VARCHAR(50),
  unit_no       VARCHAR(50),
  floor         VARCHAR(20),
  sqft          INTEGER,
  bhk           VARCHAR(20)
)
  SERVER cp_db_server
  OPTIONS (schema_name 'public', table_name 'submissions');
