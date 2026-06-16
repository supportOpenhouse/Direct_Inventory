"""One-off cleanup: strip admin user ids and the 'Unallocated' placeholder
from `inventory.assigned_rm_ids` on rows where the array also contains at
least one real RM.

Background
----------
Rows ended up with a mix like `[admin_id, real_rm, unallocated, real_rm]`
because an older `assign_missing_batch` pass included the Unallocated
placeholder in the matchable set (commit f1d6636 / 2026-06-09 fixed it).
Admin ids leaked in similarly — likely from rows assigned before Saransh
was promoted from `rm` to `admin`.

Both classes of id should never be POCs alongside real RMs:
- Admins are not RMs; the auto-assign job now filters `WHERE role = 'rm'`.
- Unallocated is the fallback when no real RM matches — never a co-assignee.

Safety model
------------
- Only rows where stripping leaves at least one real RM are touched. If a
  row would drop to zero RMs (no real RM in the array at all), it is
  reported and left alone.
- assigned_mgr_id is re-derived from the manager of the new first RM
  (mirrors the convention in api/inventory/bulk.py:67-68 — first RM's
  manager wins). Same value? Left alone.
- One activity_log row per change (action='cleanup_assigned_rms',
  field='assigned_rm_ids', before/after as JSON).
- --dry-run is default; --apply runs the writes in a single transaction.

Usage
-----
    .venv/bin/python -m backend.scripts.cleanup_assigned_rms --dry-run
    .venv/bin/python -m backend.scripts.cleanup_assigned_rms --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg2
from psycopg2.extras import execute_values, RealDictCursor
from dotenv import load_dotenv

load_dotenv("backend/.env")
DATABASE_URL = os.environ.get("DATABASE_URL", "")


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
            # Identify the to-strip id set: every active admin + the Unallocated
            # placeholder (matched by name=Unallocated to survive email drift).
            cur.execute("SELECT id, email, name FROM users WHERE role = 'admin'")
            admins = cur.fetchall()
            admin_ids = [a["id"] for a in admins]

            cur.execute(
                "SELECT id, email FROM users "
                "WHERE name = 'Unallocated' OR LOWER(email) = 'unallocated@openhouse.in' "
                "ORDER BY id LIMIT 1"
            )
            row = cur.fetchone()
            unalloc_id = row["id"] if row else None

            strip_ids = set(admin_ids) | ({unalloc_id} if unalloc_id else set())
            print(f"admin ids:       {admin_ids}")
            print(f"unallocated id:  {unalloc_id}")
            print(f"-> strip set:    {sorted(strip_ids)}")
            print()

            # Candidate rows: contain a strip id AND at least one other id.
            cur.execute(
                """SELECT id, oh_id, society, city,
                          assigned_rm_ids, assigned_mgr_id
                     FROM inventory
                    WHERE assigned_rm_ids && %s::INT[]
                      AND cardinality(assigned_rm_ids) > 1
                    ORDER BY id""",
                (list(strip_ids),),
            )
            rows = cur.fetchall()
            print(f"candidate rows: {len(rows)}")

            to_update = []   # (id, oh_id, before_ids, after_ids, before_mgr, after_mgr)
            fell_back = []   # rows whose stripped result was empty → fell back to [unallocated]
            no_change = []   # nothing to strip after dedup

            # We'll need each surviving-first-RM's manager to re-derive
            # assigned_mgr_id. Collect candidate first-RMs in one batch.
            survivors_by_row = {}
            for r in rows:
                before = list(r["assigned_rm_ids"] or [])
                after  = [x for x in before if x not in strip_ids]
                if not after:
                    # No real RM in the array — leave just [Unallocated], the
                    # canonical "no real RM matched" state. assigned_mgr_id
                    # becomes NULL (Unallocated has no manager).
                    if unalloc_id is not None:
                        after = [unalloc_id]
                        fell_back.append((r["id"], r["oh_id"], before, after))
                    else:
                        # No placeholder available → don't touch.
                        no_change.append((r["id"], r["oh_id"], before))
                        continue
                if after == before:
                    no_change.append((r["id"], r["oh_id"], before))
                    continue
                survivors_by_row[r["id"]] = (r, before, after)

            # Look up manager for every "new first RM" in one query.
            first_rms = sorted({tup[2][0] for tup in survivors_by_row.values()})
            mgr_of = {}
            if first_rms:
                cur.execute("SELECT id, manager FROM users WHERE id = ANY(%s)", (first_rms,))
                for u in cur.fetchall():
                    mgr_of[u["id"]] = u["manager"]

            for rid, (r, before, after) in survivors_by_row.items():
                # Convention: first RM's manager wins. For a row that fell back
                # to [Unallocated], that's NULL (Unallocated has no manager).
                new_mgr = mgr_of.get(after[0]) if after[0] != unalloc_id else None
                to_update.append((
                    rid, r["oh_id"],
                    before, after,
                    r["assigned_mgr_id"], new_mgr,
                ))

            print()
            print("=" * 70)
            print("VALIDATION REPORT")
            print("=" * 70)
            print(f"  will UPDATE:              {len(to_update)}")
            print(f"    of which fell back to [Unallocated]: {len(fell_back)}")
            print(f"  no change after strip:    {len(no_change)}")
            print()

            if to_update:
                print("  --- sample updates (first 10) ---")
                for rid, oh, bf, af, bm, am in to_update[:10]:
                    mgr_part = f"  mgr: {bm} -> {am}" if bm != am else ""
                    print(f"    {oh:<14} rm_ids: {bf} -> {af}{mgr_part}")
            if fell_back:
                print()
                print("  --- fell back to [Unallocated] (no real RM in array) ---")
                for rid, oh, bf, af in fell_back[:10]:
                    print(f"    {oh:<14} rm_ids: {bf} -> {af}")
            print("=" * 70)

            if args.dry_run:
                print("\nDRY RUN — no writes. Re-run with --apply to commit.")
                conn.rollback()
                return

            if not to_update:
                print("\nnothing to update. exiting.")
                conn.rollback()
                return

            # Temp table for one fast UPDATE; one activity_log per row.
            cur.execute("""
                CREATE TEMP TABLE _arm_cleanup (
                    id INT PRIMARY KEY,
                    new_rm_ids INT[] NOT NULL,
                    new_mgr_id INT
                ) ON COMMIT DROP
            """)
            execute_values(
                cur,
                "INSERT INTO _arm_cleanup (id, new_rm_ids, new_mgr_id) VALUES %s",
                [(rid, af, am) for rid, _oh, _bf, af, _bm, am in to_update],
                template="(%s::INT, %s::INT[], %s::INT)",
                page_size=500,
            )
            cur.execute("""
                UPDATE inventory i SET
                    assigned_rm_ids = c.new_rm_ids,
                    assigned_mgr_id = c.new_mgr_id
                  FROM _arm_cleanup c
                 WHERE i.id = c.id
            """)
            updated = cur.rowcount
            print(f"  rows updated: {updated}")
            if updated != len(to_update):
                print("  WARNING: row count mismatch; rolling back.")
                conn.rollback()
                sys.exit(3)

            # activity_log: one per row. Use direct INSERT for full control over
            # the before/after JSON shape.
            log_rows = [
                (
                    "system:csv_cleanup", "inventory", oh,
                    "cleanup_assigned_rms", "assigned_rm_ids",
                    json.dumps(bf), json.dumps(af),
                    json.dumps({"prev_mgr": bm, "new_mgr": am, "stripped_ids": sorted(strip_ids)}),
                )
                for _rid, oh, bf, af, bm, am in to_update
            ]
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
