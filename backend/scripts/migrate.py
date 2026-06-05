"""Apply every migrations/*.sql file in filename order against DATABASE_URL.

No psql required — runs through psycopg2. Each file is executed as a single
batch under autocommit, so files that manage their own BEGIN/COMMIT keep doing
so and the rest run statement-by-statement. Migrations are written to be
idempotent (CREATE ... IF NOT EXISTS, ON CONFLICT, guarded DO blocks), so this
is safe to re-run.

Usage (from the repo root):
    backend/.venv/bin/python -m backend.scripts.migrate
"""
from __future__ import annotations

import os
import sys

import psycopg2
from dotenv import load_dotenv

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.dirname(_HERE)
_MIGRATIONS_DIR = os.path.join(_BACKEND_DIR, "migrations")

# Load backend/.env regardless of where we're invoked from.
load_dotenv(os.path.join(_BACKEND_DIR, ".env"))
load_dotenv()  # also honour a repo-root .env if present


def main() -> int:
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        print("ERROR: DATABASE_URL is not set (backend/.env)", file=sys.stderr)
        return 2

    files = sorted(f for f in os.listdir(_MIGRATIONS_DIR) if f.endswith(".sql"))
    if not files:
        print("no .sql files in migrations/", file=sys.stderr)
        return 1

    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    try:
        for name in files:
            path = os.path.join(_MIGRATIONS_DIR, name)
            with open(path, "r", encoding="utf-8") as fh:
                sql = fh.read()
            try:
                with conn.cursor() as cur:
                    cur.execute(sql)
                print(f"  ✓ {name}")
            except Exception as e:
                print(f"  ✗ {name}: {type(e).__name__}: {e}", file=sys.stderr)
                return 1
    finally:
        conn.close()

    print(f"\nApplied {len(files)} migration files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
