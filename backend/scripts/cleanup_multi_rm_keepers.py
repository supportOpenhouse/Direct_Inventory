"""Resolve multi-RM rows by keeping a designated 'keeper' RM and dropping
the rest.

Per the call made on 2026-06-16:
  - Wherever Navjeevan Mishra (#39) is one of the RMs, keep only Navjeevan.
  - Wherever Aanchal Khatri (#37) is one of the RMs, keep only Aanchal.

The Rupali Prasad (#9) + Sushmita Roy (#10) row is intentionally left alone —
it's being reviewed manually.

assigned_mgr_id is re-derived from the keeper's `users.manager`. One
activity_log entry per row (action='cleanup_multi_rm_keep').

Usage
-----
    .venv/bin/python -m backend.scripts.cleanup_multi_rm_keepers --dry-run
    .venv/bin/python -m backend.scripts.cleanup_multi_rm_keepers --apply
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

# Priority order: if both keepers somehow share a row, the first one wins.
# (Doesn't apply today — Navjeevan = Noida, Aanchal = Ghaziabad — but defended.)
KEEPERS = [39, 37]


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
            # Look up keeper users (id, name, manager) so we can re-derive
            # assigned_mgr_id and label the report.
            cur.execute("SELECT id, name, manager FROM users WHERE id = ANY(%s)", (KEEPERS,))
            users = {u["id"]: u for u in cur.fetchall()}
            missing = [k for k in KEEPERS if k not in users]
            if missing:
                print(f"ABORT: keeper user(s) not found: {missing}")
                sys.exit(3)
            for k in KEEPERS:
                u = users[k]
                print(f"keeper #{k:>2} {u['name']:<20}  manager={u['manager']}")

            # Candidate rows: multi-RM AND contain at least one keeper.
            cur.execute(
                """SELECT id, oh_id, society, city, assigned_rm_ids, assigned_mgr_id
                     FROM inventory
                    WHERE cardinality(assigned_rm_ids) > 1
                      AND assigned_rm_ids && %s::INT[]
                    ORDER BY id""",
                (KEEPERS,),
            )
            rows = cur.fetchall()
            print(f"\ncandidate rows: {len(rows)}")

            to_update = []  # (id, oh_id, before, after, before_mgr, after_mgr, keeper_id)
            for r in rows:
                before = list(r["assigned_rm_ids"] or [])
                keeper = next((k for k in KEEPERS if k in before), None)
                if keeper is None:  # shouldn't hit thanks to the && filter
                    continue
                after = [keeper]
                new_mgr = users[keeper]["manager"]
                to_update.append((
                    r["id"], r["oh_id"],
                    before, after,
                    r["assigned_mgr_id"], new_mgr,
                    keeper,
                ))

            # Per-keeper counts for the report.
            from collections import Counter
            by_keeper = Counter(t[6] for t in to_update)

            print()
            print("=" * 70)
            print("VALIDATION REPORT")
            print("=" * 70)
            print(f"  total writes: {len(to_update)}")
            for kid, n in sorted(by_keeper.items()):
                print(f"    kept #{kid} {users[kid]['name']:<20} on {n} rows")
            print()
            print("  --- sample updates (first 12) ---")
            for _id, oh, bf, af, bm, am, kid in to_update[:12]:
                mgr_part = f"  mgr: {bm} -> {am}" if bm != am else f"  mgr: {bm}"
                print(f"    {oh:<14} rm_ids: {bf} -> {af}{mgr_part}  (keeper={users[kid]['name']})")
            if len(to_update) > 12:
                print(f"    ... and {len(to_update) - 12} more")
            print("=" * 70)

            if args.dry_run:
                print("\nDRY RUN — no writes. Re-run with --apply to commit.")
                conn.rollback()
                return

            if not to_update:
                print("\nnothing to update.")
                conn.rollback()
                return

            cur.execute("""
                CREATE TEMP TABLE _multi_keep (
                    id INT PRIMARY KEY,
                    new_rm_ids INT[] NOT NULL,
                    new_mgr_id INT
                ) ON COMMIT DROP
            """)
            execute_values(
                cur,
                "INSERT INTO _multi_keep (id, new_rm_ids, new_mgr_id) VALUES %s",
                [(rid, af, am) for rid, _oh, _bf, af, _bm, am, _k in to_update],
                template="(%s::INT, %s::INT[], %s::INT)",
                page_size=500,
            )
            cur.execute("""
                UPDATE inventory i SET
                    assigned_rm_ids = c.new_rm_ids,
                    assigned_mgr_id = c.new_mgr_id
                  FROM _multi_keep c
                 WHERE i.id = c.id
            """)
            updated = cur.rowcount
            print(f"\nrows updated: {updated}")
            if updated != len(to_update):
                print("WARNING: row count mismatch; rolling back.")
                conn.rollback()
                sys.exit(3)

            log_rows = []
            for _rid, oh, bf, af, bm, am, kid in to_update:
                log_rows.append((
                    "system:csv_cleanup", "inventory", oh,
                    "cleanup_multi_rm_keep", "assigned_rm_ids",
                    json.dumps(bf), json.dumps(af),
                    json.dumps({
                        "keeper_id":   kid,
                        "keeper_name": users[kid]["name"],
                        "prev_mgr":    bm,
                        "new_mgr":     am,
                    }),
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
