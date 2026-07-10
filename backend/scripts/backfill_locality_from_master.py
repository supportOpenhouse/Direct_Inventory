"""Backfill inventory.locality from PROPERTIES_DB.master_societies.

Cross-DB: societies live in the inventory DB (DATABASE_URL), the canonical
society→locality map lives in the Properties DB (PROPERTIES_DB_URL). This matches
inventory.society to master_societies.society_name (case/whitespace-insensitive,
the same way the app matches societies) and overwrites inventory.locality with the
master locality. Leads whose society has no master match are left untouched.

Run (from repo root):
    backend/.venv/bin/python -m backend.scripts.backfill_locality_from_master
    backend/.venv/bin/python -m backend.scripts.backfill_locality_from_master --dry   # preview, no writes
"""
from __future__ import annotations

import os
import sys

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values

try:
    from dotenv import load_dotenv
    _BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(_BACKEND, ".env"))
except Exception:  # pragma: no cover
    pass

DRY = "--dry" in sys.argv
# Set to True to ONLY fill blank/empty localities (never overwrite a set value).
FILL_BLANKS_ONLY = "--blanks-only" in sys.argv


def main() -> int:
    inv_url = os.environ.get("DATABASE_URL")
    props_url = os.environ.get("PROPERTIES_DB_URL")
    if not inv_url or not props_url:
        print("ERROR: DATABASE_URL and PROPERTIES_DB_URL must be set", file=sys.stderr)
        return 2

    # 1) society (lowercased/trimmed) -> locality, from master_societies.
    pconn = psycopg2.connect(props_url)
    try:
        with pconn.cursor(cursor_factory=RealDictCursor) as pcur:
            pcur.execute(
                """SELECT LOWER(TRIM(society_name)) AS soc_lc, TRIM(locality) AS locality
                   FROM master_societies
                   WHERE society_name IS NOT NULL AND TRIM(society_name) <> ''
                     AND locality IS NOT NULL AND TRIM(locality) <> ''"""
            )
            mapping: dict[str, str] = {}
            for r in pcur.fetchall():
                mapping.setdefault(r["soc_lc"], r["locality"])  # first non-empty wins
    finally:
        pconn.close()
    print(f"master_societies: {len(mapping)} distinct societies with a locality")
    if not mapping:
        print("nothing to map")
        return 0

    # 2) Push onto inventory via a temp lookup table + one UPDATE.
    blank_guard = "AND (i.locality IS NULL OR TRIM(i.locality) = '')" if FILL_BLANKS_ONLY else ""
    conn = psycopg2.connect(inv_url)
    try:
        cur = conn.cursor()
        cur.execute("CREATE TEMP TABLE _soc_loc (soc_lc TEXT PRIMARY KEY, locality TEXT)")
        execute_values(
            cur,
            "INSERT INTO _soc_loc (soc_lc, locality) VALUES %s ON CONFLICT (soc_lc) DO NOTHING",
            list(mapping.items()),
        )
        cur.execute(
            f"""SELECT count(*) FROM inventory i JOIN _soc_loc m
                   ON LOWER(TRIM(i.society)) = m.soc_lc
                 WHERE i.locality IS DISTINCT FROM m.locality {blank_guard}"""
        )
        to_change = cur.fetchone()[0]
        print(f"inventory rows that would change: {to_change}")

        if DRY:
            conn.rollback()
            print("dry run — no changes written")
            return 0

        cur.execute(
            f"""UPDATE inventory i SET locality = m.locality
                FROM _soc_loc m
                WHERE LOWER(TRIM(i.society)) = m.soc_lc
                  AND i.locality IS DISTINCT FROM m.locality {blank_guard}"""
        )
        conn.commit()
        print(f"updated {cur.rowcount} inventory rows")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
