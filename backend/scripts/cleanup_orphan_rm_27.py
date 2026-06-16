"""Cleanup: replace the orphan user id 27 in inventory.assigned_rm_ids.

User id 27 was hard-deleted from the users table at some point (no
activity_log evidence) yet still appears as a POC on ~200 inventory rows.

Rule applied per row
--------------------
- If `assigned_rm_ids = [27]` (sole orphan owner)
    -> set to `[Unallocated]` so the lead re-enters the no-match pool with
       a real placeholder POC and a visible owner.
- If `assigned_rm_ids = [..., 27, ...]` with at least one real RM also there
    -> drop just 27, keep the remaining ids. Don't add Unallocated alongside
       real RMs — that's the exact bug cleanup_assigned_rms just fixed.

assigned_mgr_id is re-derived from the new first id's manager (matches the
convention in api/inventory/bulk.py:67-68). Unallocated has no manager, so
sole-orphan rows end with assigned_mgr_id = NULL.

One activity_log entry per row (action='cleanup_orphan_rm_27',
field='assigned_rm_ids', JSON before/after).

Usage
-----
    .venv/bin/python -m backend.scripts.cleanup_orphan_rm_27 --dry-run
    .venv/bin/python -m backend.scripts.cleanup_orphan_rm_27 --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

import psycopg2
from psycopg2.extras import execute_values, RealDictCursor
from dotenv import load_dotenv

load_dotenv("backend/.env")
DATABASE_URL = os.environ.get("DATABASE_URL", "")

ORPHAN_ID = 27


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--apply",   action="store_true")
    args = ap.parse_args()

    if not DATABASE_URL:
        print("ERROR: DATABASE_URL not set in backend/.env", file=sys.stderr)
        sys.exit(2)

    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            # Defensive: confirm orphan id is still orphan before we treat it as one.
            cur.execute("SELECT id, email, name FROM users WHERE id = %s", (ORPHAN_ID,))
            existing = cur.fetchone()
            if existing:
                print(f"ABORT: user id {ORPHAN_ID} now exists in users: {dict(existing)}")
                print("       Either rename the script's ORPHAN_ID or treat #27 as a real RM.")
                sys.exit(3)

            # Unallocated placeholder lookup (mirrors cleanup_assigned_rms).
            cur.execute(
                "SELECT id, name FROM users "
                "WHERE name = 'Unallocated' OR LOWER(email) = 'unallocated@openhouse.in' "
                "ORDER BY id LIMIT 1"
            )
            row = cur.fetchone()
            unalloc_id = row["id"] if row else None
            if unalloc_id is None:
                print("ABORT: no Unallocated user found. Run migration 026 first.")
                sys.exit(3)
            print(f"orphan id:       {ORPHAN_ID} (confirmed missing from users)")
            print(f"unallocated id:  {unalloc_id}")

            cur.execute(
                """SELECT id, oh_id, assigned_rm_ids, assigned_mgr_id
                     FROM inventory
                    WHERE %s = ANY(assigned_rm_ids)
                    ORDER BY id""",
                (ORPHAN_ID,),
            )
            rows = cur.fetchall()
            print(f"\ncandidate rows: {len(rows)}")

            sole_orphan = []   # [27] -> [Unallocated]
            mixed       = []   # [..., 27, ...] -> drop 27

            for r in rows:
                before = list(r["assigned_rm_ids"] or [])
                stripped = [x for x in before if x != ORPHAN_ID]
                if not stripped:
                    sole_orphan.append((r["id"], r["oh_id"], before, [unalloc_id]))
                else:
                    mixed.append((r["id"], r["oh_id"], before, stripped))

            # Manager re-derivation for the `mixed` bucket (first id's manager).
            first_ids = sorted({m[3][0] for m in mixed})
            mgr_of = {}
            if first_ids:
                cur.execute("SELECT id, manager FROM users WHERE id = ANY(%s)", (first_ids,))
                for u in cur.fetchall():
                    mgr_of[u["id"]] = u["manager"]

            print()
            print("=" * 70)
            print("VALIDATION REPORT")
            print("=" * 70)
            print(f"  sole-orphan [27] -> [Unallocated]:  {len(sole_orphan)}")
            print(f"  mixed [...,27,...] -> drop 27:      {len(mixed)}")
            print(f"  total writes:                       {len(sole_orphan) + len(mixed)}")

            if mixed:
                print()
                print("  --- mixed rows (will keep real RM) ---")
                for _id, oh, bf, af in mixed:
                    print(f"    {oh:<14} rm_ids: {bf} -> {af}  mgr -> {mgr_of.get(af[0])}")
            if sole_orphan:
                print()
                print(f"  --- sole-orphan rows (first 10 of {len(sole_orphan)}) ---")
                for _id, oh, bf, af in sole_orphan[:10]:
                    print(f"    {oh:<14} rm_ids: {bf} -> {af}")
                if len(sole_orphan) > 10:
                    print(f"    ... and {len(sole_orphan) - 10} more")

            # City breakdown — sanity-check that we're not silently mass-Unallocating
            # one city's entire inventory.
            cur.execute(
                """SELECT city, COUNT(*) AS n
                     FROM inventory
                    WHERE %s = ANY(assigned_rm_ids)
                      AND cardinality(assigned_rm_ids) = 1
                    GROUP BY city ORDER BY n DESC""",
                (ORPHAN_ID,),
            )
            print()
            print("  city distribution of sole-orphan rows:")
            for r in cur.fetchall():
                print(f"    {r['city']:<15} {r['n']}")
            print("=" * 70)

            if args.dry_run:
                print("\nDRY RUN — no writes. Re-run with --apply to commit.")
                conn.rollback()
                return

            # APPLY — one temp-table-driven UPDATE for each bucket.
            cur.execute("""
                CREATE TEMP TABLE _orphan_cleanup (
                    id INT PRIMARY KEY,
                    new_rm_ids INT[] NOT NULL,
                    new_mgr_id INT
                ) ON COMMIT DROP
            """)
            payload = []
            for rid, _oh, _bf, af in sole_orphan:
                payload.append((rid, af, None))  # Unallocated has no manager
            for rid, _oh, _bf, af in mixed:
                payload.append((rid, af, mgr_of.get(af[0])))
            execute_values(
                cur,
                "INSERT INTO _orphan_cleanup (id, new_rm_ids, new_mgr_id) VALUES %s",
                payload,
                template="(%s::INT, %s::INT[], %s::INT)",
                page_size=500,
            )
            cur.execute("""
                UPDATE inventory i SET
                    assigned_rm_ids = c.new_rm_ids,
                    assigned_mgr_id = c.new_mgr_id
                  FROM _orphan_cleanup c
                 WHERE i.id = c.id
            """)
            updated = cur.rowcount
            print(f"\nrows updated: {updated}")
            if updated != len(payload):
                print("WARNING: row count mismatch; rolling back.")
                conn.rollback()
                sys.exit(3)

            log_rows = []
            for rid, oh, bf, af in sole_orphan + mixed:
                log_rows.append((
                    "system:csv_cleanup", "inventory", oh,
                    "cleanup_orphan_rm_27", "assigned_rm_ids",
                    json.dumps(bf), json.dumps(af),
                    json.dumps({"orphan_id": ORPHAN_ID, "fallback_to_unallocated": (af == [unalloc_id])}),
                ))
            execute_values(
                cur,
                """INSERT INTO activity_log
                       (actor_email, entity_type, entity_id, action, field,
                        before_value, after_value, metadata)
                   VALUES %s""",
                log_rows,
                template="(%s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
                page_size=500,
            )
            conn.commit()
            print(f"COMMITTED. {updated} rows cleaned, {len(log_rows)} activity_log entries.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
