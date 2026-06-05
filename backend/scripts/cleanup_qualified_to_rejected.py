"""One-off data cleanup: apply qualified -> rejected stage changes from an
edited CSV export, with reject_reason.

Safety model
------------
- Reads the CSV and the current DB state in one shot.
- Only touches rows where:
    * DB.stage = 'qualified'              (source of truth: live DB)
    * CSV.stage = 'rejected'              (the edit we want to apply)
    * CSV.reject_reason is set and is one of the VALID_REJECT_REASONS
- Anything else is reported, not changed.
- --dry-run (default) prints the diff; --apply runs UPDATEs in a single
  transaction and writes an activity_log entry.

Usage:
    .venv/bin/python -m backend.scripts.cleanup_qualified_to_rejected \\
        "/abs/path/to/Direct Data Cleaning - May 23 - Sheet1.csv" --dry-run

    .venv/bin/python -m backend.scripts.cleanup_qualified_to_rejected \\
        "/abs/path/to/Direct Data Cleaning - May 23 - Sheet1.csv" --apply
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import Counter

import psycopg2
from psycopg2.extras import execute_values, RealDictCursor
from dotenv import load_dotenv

load_dotenv("backend/.env")
DATABASE_URL = os.environ.get("DATABASE_URL", "")

VALID_REJECT_REASONS = {
    "not_interested",
    "invalid_duplicate",
    "future_prospect",
    "oh_rejected",
    "sold",
    "broker_listing",
}


def read_csv_rejected(path: str) -> dict:
    """Return {id_int: (oh_id, reject_reason)} for rows where CSV.stage == 'rejected'."""
    out = {}
    bad_reason_rows = []
    blank_reason_rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if (row.get("stage") or "").strip() != "rejected":
                continue
            try:
                rid = int((row.get("id") or "").strip())
            except (TypeError, ValueError):
                continue
            oh_id  = (row.get("oh_id") or "").strip()
            reason = (row.get("reject_reason") or "").strip()
            if not reason:
                blank_reason_rows.append((rid, oh_id))
                continue
            if reason not in VALID_REJECT_REASONS:
                bad_reason_rows.append((rid, oh_id, reason))
                continue
            out[rid] = (oh_id, reason)
    return out, bad_reason_rows, blank_reason_rows


def fetch_db_state(cur, ids: list[int]) -> dict:
    """Return {id: {'oh_id':..., 'stage':..., 'reject_reason':...}} for given ids."""
    if not ids:
        return {}
    cur.execute(
        "SELECT id, oh_id, stage, stage_reason AS reject_reason FROM inventory WHERE id = ANY(%s)",
        (ids,),
    )
    return {r["id"]: dict(r) for r in cur.fetchall()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    if not DATABASE_URL:
        print("ERROR: DATABASE_URL not set in backend/.env", file=sys.stderr)
        sys.exit(2)

    print(f"reading CSV: {args.csv_path}")
    csv_rejected, bad_reason, blank_reason = read_csv_rejected(args.csv_path)
    print(f"  csv rows with stage=rejected (valid reject_reason): {len(csv_rejected)}")
    if blank_reason:
        print(f"  WARNING: {len(blank_reason)} rejected rows in CSV have BLANK reject_reason — skipping")
        for rid, oh in blank_reason[:10]:
            print(f"    id={rid} oh_id={oh}")
        if len(blank_reason) > 10:
            print(f"    ... and {len(blank_reason)-10} more")
    if bad_reason:
        print(f"  WARNING: {len(bad_reason)} rejected rows in CSV have INVALID reject_reason — skipping")
        for rid, oh, rsn in bad_reason[:10]:
            print(f"    id={rid} oh_id={oh} reason={rsn!r}")
        if len(bad_reason) > 10:
            print(f"    ... and {len(bad_reason)-10} more")

    if not csv_rejected:
        print("nothing to do.")
        return

    print("connecting to DB ...")
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            ids = sorted(csv_rejected.keys())
            print(f"fetching current DB state for {len(ids)} ids ...")
            db_state = fetch_db_state(cur, ids)
            print(f"  rows found in DB: {len(db_state)}")

            missing_in_db   = []
            oh_id_mismatch  = []
            already_correct = []  # already rejected with same reason
            already_rejected_diff_reason = []
            other_stage     = Counter()   # db stage -> count, for rows we skip
            other_stage_samples = {}      # db stage -> [(id, oh_id, csv_reason)]
            to_update       = []          # (id, oh_id, new_reason, prev_stage, prev_reason)

            for rid in ids:
                csv_oh, csv_reason = csv_rejected[rid]
                row = db_state.get(rid)
                if row is None:
                    missing_in_db.append((rid, csv_oh))
                    continue
                if csv_oh and row["oh_id"] and row["oh_id"] != csv_oh:
                    oh_id_mismatch.append((rid, csv_oh, row["oh_id"]))
                    continue
                db_stage  = row["stage"]
                db_reason = row["reject_reason"]
                if db_stage == "qualified":
                    to_update.append((rid, row["oh_id"], csv_reason, db_stage, db_reason))
                elif db_stage == "rejected":
                    if db_reason == csv_reason:
                        already_correct.append((rid, row["oh_id"]))
                    else:
                        already_rejected_diff_reason.append(
                            (rid, row["oh_id"], db_reason, csv_reason)
                        )
                else:
                    other_stage[db_stage] += 1
                    other_stage_samples.setdefault(db_stage, []).append(
                        (rid, row["oh_id"], csv_reason)
                    )

            print()
            print("=" * 70)
            print("VALIDATION REPORT")
            print("=" * 70)
            print(f"  will UPDATE  (db.stage=qualified -> rejected): {len(to_update)}")
            print(f"  already rejected with same reason  (skip):     {len(already_correct)}")
            print(f"  already rejected with DIFFERENT reason (skip): {len(already_rejected_diff_reason)}")
            print(f"  in other db stage (skip):                      {sum(other_stage.values())}")
            for st, n in other_stage.most_common():
                print(f"      db.stage={st!r:25} {n}")
            print(f"  id missing from DB (skip):                     {len(missing_in_db)}")
            print(f"  oh_id mismatch between CSV/DB (skip):          {len(oh_id_mismatch)}")
            print(f"  blank reject_reason in CSV (skip):             {len(blank_reason)}")
            print(f"  invalid reject_reason in CSV (skip):           {len(bad_reason)}")

            # Sample previews
            if to_update:
                print()
                print("  --- sample of updates (first 10) ---")
                for rid, oh, reason, _ps, _pr in to_update[:10]:
                    print(f"    id={rid:>6} oh_id={oh:<14} reject_reason -> {reason}")
            if already_rejected_diff_reason:
                print()
                print("  --- already rejected w/ different reason (first 10) ---")
                for rid, oh, db_r, csv_r in already_rejected_diff_reason[:10]:
                    print(f"    id={rid:>6} oh_id={oh:<14} db.reason={db_r!r:24} csv.reason={csv_r!r}")
            if other_stage:
                print()
                print("  --- samples of rows in other db stages (first 5 per stage) ---")
                for st, samples in other_stage_samples.items():
                    print(f"    db.stage={st!r}:")
                    for rid, oh, csv_r in samples[:5]:
                        print(f"      id={rid:>6} oh_id={oh:<14} csv wanted reject_reason={csv_r!r}")
            if missing_in_db:
                print()
                print("  --- ids missing from DB (first 10) ---")
                for rid, oh in missing_in_db[:10]:
                    print(f"    id={rid} csv_oh_id={oh}")
            if oh_id_mismatch:
                print()
                print("  --- oh_id mismatches (first 10) ---")
                for rid, csv_oh, db_oh in oh_id_mismatch[:10]:
                    print(f"    id={rid} csv_oh_id={csv_oh} db_oh_id={db_oh}")
            print("=" * 70)

            if args.dry_run:
                print("\nDRY RUN — no writes. Re-run with --apply to commit.")
                conn.rollback()
                return

            if not to_update:
                print("\nnothing to update. exiting.")
                conn.rollback()
                return

            # APPLY
            print(f"\napplying UPDATE to {len(to_update)} rows ...")
            cur.execute("""
                CREATE TEMP TABLE _stage_cleanup (
                    id INT PRIMARY KEY,
                    new_reason TEXT NOT NULL
                ) ON COMMIT DROP
            """)
            execute_values(
                cur,
                "INSERT INTO _stage_cleanup (id, new_reason) VALUES %s",
                [(rid, reason) for rid, _oh, reason, _ps, _pr in to_update],
                page_size=1000,
            )
            cur.execute("""
                UPDATE inventory i
                   SET stage = 'rejected',
                       stage_reason = c.new_reason,
                       updated_at = NOW()
                  FROM _stage_cleanup c
                 WHERE i.id = c.id
                   AND i.stage = 'qualified'
            """)
            updated = cur.rowcount
            print(f"  rows updated: {updated}")

            if updated != len(to_update):
                print("  WARNING: updated count does not match planned count; rolling back.")
                conn.rollback()
                sys.exit(3)

            cur.execute(
                "INSERT INTO activity_log (actor_email, entity_type, action, metadata) "
                "VALUES (%s, 'inventory', 'bulk_stage_cleanup', %s::jsonb)",
                (
                    "system:csv_cleanup",
                    f'{{"updated": {updated}, "from_stage": "qualified", "to_stage": "rejected", '
                    f'"csv": "{os.path.basename(args.csv_path)}"}}',
                ),
            )
            conn.commit()
            print("COMMITTED.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
