"""One-off: fill inventory.cp_match_ids (046) for every lead, re-checking each
one against the CP DB.

Real run = the exact same backfill_one_chunk() the "CP Scan" button calls, looped
until done — so it ALSO re-derives cp_match and the green/red star_color on every
row it touches (manual yellow/pink/blue stars are never overwritten). Picks up
rows where cp_match OR cp_match_ids is NULL; after 046 that's every lead.

--dry computes the same thing and prints what would change — verdict transitions,
star flips, multi-match counts — writing nothing. Run it first.

Run (from repo root):
    .venv/bin/python -m backend.scripts.backfill_cp_match_ids --dry
    .venv/bin/python -m backend.scripts.backfill_cp_match_ids
"""
from __future__ import annotations

import os
import sys
import time
from collections import Counter

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.db import get_conn  # noqa: E402
from backend.services.cp_match import (  # noqa: E402
    CHUNK_SIZE, _matches, _norm, _norm_bhk, _query_cp, _verdict, backfill_one_chunk,
)

STAR_FOR = {"perfect": "green", "partial": "red"}


def dry_run() -> int:
    transitions, star_flips = Counter(), Counter()
    rows_total = multi = ids_total = 0
    conn = get_conn()
    try:
        cursor = 0
        while True:
            with conn.cursor() as cur:
                # Same WHERE as backfill_one_chunk, minus the write.
                cur.execute(
                    "SELECT id, society, bedrooms, floor, tower, unit_no, area_sqft, cp_match, star_color "
                    "FROM inventory WHERE (cp_match IS NULL OR cp_match_ids IS NULL) "
                    "  AND NOT consider_deleted AND id > %s "
                    "  AND society IS NOT NULL AND TRIM(society) <> '' AND bedrooms IS NOT NULL "
                    "ORDER BY id LIMIT %s",
                    (cursor, CHUNK_SIZE),
                )
                rows = cur.fetchall()
            conn.rollback()
            if not rows:
                break
            keys = {(_norm(r["society"]), _norm_bhk(r["bedrooms"])) for r in rows}
            index = _query_cp({k for k in keys if k[0] and k[1] is not None})
            for r in rows:
                m = _matches(r, index)
                new = _verdict(m) or "none"
                old = r["cp_match"] or "NULL"
                if old != new:
                    transitions[f"{old} → {new}"] += 1
                # Mirror the scan's star CASE: only NULL / green / red stars are its to set.
                if r["star_color"] in (None, "green", "red"):
                    new_star = STAR_FOR.get(new)
                    if new_star != r["star_color"]:
                        star_flips[f"{r['star_color'] or 'none'} → {new_star or 'none'}"] += 1
                rows_total += 1
                ids_total += len(m)
                multi += len(m) > 1
            cursor = rows[-1]["id"]
            print(f"  scanned {rows_total} …", flush=True)
    finally:
        conn.close()

    print(f"\nDRY RUN — nothing written. {rows_total} leads would be (re)scanned.")
    print(f"  matched CP ids to store: {ids_total}  ·  leads with >1 match: {multi}")
    print(f"  cp_match changes: {sum(transitions.values())}")
    for k, v in transitions.most_common():
        print(f"    {k}: {v}")
    print(f"  star_color changes (green/red/none only): {sum(star_flips.values())}")
    for k, v in star_flips.most_common():
        print(f"    {k}: {v}")
    return 0


def main() -> int:
    if "--dry" in sys.argv:
        return dry_run()

    totals = Counter()
    cursor, chunks, t0 = "", 0, time.time()
    conn = get_conn()
    try:
        while True:
            chunk = backfill_one_chunk(conn, cursor)  # commits per chunk
            chunks += 1
            for k in ("processed", "perfect", "partial", "no_match"):
                totals[k] += chunk[k]
            print(f"  chunk {chunks}: processed={chunk['processed']} "
                  f"perfect={chunk['perfect']} partial={chunk['partial']} none={chunk['no_match']}", flush=True)
            if chunk["done"]:
                break
            cursor = chunk["next_cursor"]
    finally:
        conn.close()
    print(f"\nDone in {time.time() - t0:.1f}s over {chunks} chunks — "
          f"processed={totals['processed']} perfect={totals['perfect']} "
          f"partial={totals['partial']} none={totals['no_match']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
