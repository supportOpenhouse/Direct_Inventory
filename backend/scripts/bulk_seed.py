"""One-time bulk seed of the inventory table from a CSV export of the data sheet.

Use this for the initial 15k-row import; Render's free tier can't handle it
through /api/sync/sheet without timing out per-batch. After this script runs,
the existing Apps Script daily sync handles ~50-500 row deltas just fine.

Connects directly to the app DB via DATABASE_URL in backend/.env.

Pipeline:
  1. Read CSV (header row → snake_case column names like the Apps Script does)
  2. Skip rows where listing_link OR city is empty/unknown
  3. Pre-generate OH-IDs per city in Python (not via the per-row counter)
  4. Resolve RM/manager assignment in Python from a single rm_mapping fetch
  5. Bulk-INSERT via execute_values, ON CONFLICT (listing_link) DO UPDATE
  6. Bump oh_id_counter to reflect what we allocated

Usage:
  cd /path/to/Direct-Inventory-Portal
  .venv/bin/python -m backend.scripts.bulk_seed path/to/sheet_export.csv
"""
from __future__ import annotations

import csv
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, date

import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

load_dotenv("backend/.env")
DATABASE_URL = os.environ["DATABASE_URL"]

CITY_TO_CODE = {
    "noida": "N",
    "greater noida": "N",
    "gurgaon": "G",
    "gurugram": "G",
    "ghaziabad": "GH",
}


def _norm(k: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (k or "").strip().lower()).strip("_")


def _parse_int(v):
    if v is None or v == "":
        return None
    try:
        return int(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _parse_date(v):
    if not v:
        return None
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _format_oh_id(code: str, counter: int, suffix: str) -> str:
    return f"OHL{code}D{counter:04d}{suffix}"


def _next_suffix(suffix: str) -> str:
    if suffix == "":
        return "A"
    if len(suffix) == 1 and suffix < "Z":
        return chr(ord(suffix) + 1)
    raise RuntimeError(f"suffix beyond 'Z' not supported in this seed: {suffix!r}")


def read_csv(path: str) -> tuple[list[str], list[dict]]:
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        rows = list(reader)
    if not rows:
        return ([], [])
    headers = [_norm(h) for h in rows[0]]
    out = []
    for row in rows[1:]:
        rec = {h: (row[i] if i < len(row) else "") for i, h in enumerate(headers) if h}
        out.append(rec)
    return (headers, out)


def normalize(rec: dict) -> dict | None:
    listing = (rec.get("listing_link") or "").strip()
    city    = (rec.get("city") or "").strip()
    if not listing or not city:
        return None
    if city.lower() not in CITY_TO_CODE:
        return None
    return {
        "source":       (rec.get("source") or "").strip() or None,
        "city":         city,
        "locality":     (rec.get("locality") or "").strip() or None,
        "society":      (rec.get("society") or "").strip() or None,
        "bedrooms":     _parse_int(rec.get("bedrooms")),
        "area_sqft":    _parse_int(rec.get("area_sqft") or rec.get("area")),
        "floor":        (str(rec.get("floor")).strip() if rec.get("floor") not in (None, "") else None),
        "price":        _parse_int(rec.get("price")),
        "seller_name":  (rec.get("seller_name") or "").strip() or None,
        "posting_date": _parse_date(rec.get("posting_date")),
        "listing_link": listing,
    }


def fetch_rm_mappings(cur) -> dict:
    """Build a lookup: (city, locality, society) -> (rm_id, mgr_id), with NULLs as wildcards."""
    cur.execute("""SELECT city, locality, society, rm_user_id, manager_user_id
                   FROM rm_mapping ORDER BY id""")
    mappings = cur.fetchall()
    return mappings


def resolve(mappings: list, *, city: str, locality: str | None, society: str | None):
    """In-memory resolver, mirrors backend.services.assignment.resolve_assignment."""
    best = None
    best_score = -1
    for m in mappings:
        m_city, m_loc, m_soc, m_rm, m_mgr = m
        if m_city != city:
            continue
        score = 0
        if m_soc is not None:
            if m_soc == society and (m_loc is None or m_loc == locality):
                score = 3
            else:
                continue
        elif m_loc is not None:
            if m_loc == locality:
                score = 2
            else:
                continue
        else:
            score = 1  # city-wide fallback
        if score > best_score:
            best, best_score = (m_rm, m_mgr), score
    return best or (None, None)


def fetch_existing_listing_links(cur) -> set:
    cur.execute("SELECT listing_link FROM inventory")
    return {r[0] for r in cur.fetchall()}


def fetch_counters(cur) -> dict:
    cur.execute("SELECT city_code, counter, suffix FROM oh_id_counter")
    return {r[0]: (r[1], r[2]) for r in cur.fetchall()}


def allocate_oh_ids(records: list[dict], counters: dict) -> tuple[list[str], dict]:
    """Allocate one OH-ID per record. Returns (list_of_ids, updated_counters)."""
    ids = []
    counters = dict(counters)  # mutate copy
    for rec in records:
        code = CITY_TO_CODE[rec["city"].lower()]
        counter, suffix = counters.get(code, (0, ""))
        counter += 1
        if counter > 9999:
            counter = 1
            suffix = _next_suffix(suffix)
        counters[code] = (counter, suffix)
        ids.append(_format_oh_id(code, counter, suffix))
    return (ids, counters)


def main(csv_path: str):
    started = time.time()
    print(f"reading {csv_path} ...")
    headers, rows = read_csv(csv_path)
    print(f"  headers: {headers}")
    print(f"  rows: {len(rows)}")

    print("normalizing ...")
    normalized = []
    skipped = 0
    for r in rows:
        nr = normalize(r)
        if nr is None:
            skipped += 1
        else:
            normalized.append(nr)
    print(f"  kept: {len(normalized)} | skipped: {skipped}")

    if not normalized:
        print("no rows to import. done.")
        return

    print("connecting to Neon ...")
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            print("fetching existing listing_links to dedup ...")
            existing = fetch_existing_listing_links(cur)
            print(f"  already in DB: {len(existing)}")

            new_records = [r for r in normalized if r["listing_link"] not in existing]
            update_records = [r for r in normalized if r["listing_link"] in existing]
            print(f"  new: {len(new_records)} | already-present (will UPDATE): {len(update_records)}")

            print("fetching counters ...")
            counters = fetch_counters(cur)
            print(f"  counters: {counters}")

            print("allocating OH-IDs ...")
            ids, new_counters = allocate_oh_ids(new_records, counters)

            # POC assignment is no longer resolved at seed time. The rm_mapping
            # table was retired in migration 016; RMs now resolve from the
            # users table (society → micro_market → city). New rows land with an
            # empty assigned_rm_ids and stage 'lead'; run the assign-missing
            # backfill afterwards to populate POCs:
            #     POST /api/inventory/assign-missing  (or it runs on board load).
            print("building insert tuples ...")
            tuples = []
            for rec, oh_id in zip(new_records, ids):
                tuples.append((
                    oh_id, rec["source"], rec["city"], rec["locality"], rec["society"],
                    rec["bedrooms"], rec["area_sqft"], rec["floor"], rec["price"],
                    rec["seller_name"], rec["posting_date"], rec["listing_link"],
                    "lead",
                ))

            if tuples:
                print(f"bulk INSERT of {len(tuples)} rows ...")
                # assigned_rm_ids defaults to '{}'; follow_up_at defaults to
                # today (IST) — matches created_at's date and the Board's
                # "Posted" column.
                execute_values(cur, """
                    INSERT INTO inventory (
                        oh_id, source, city, locality, society, bedrooms, area_sqft,
                        floor, price, seller_name, posting_date, listing_link,
                        stage, follow_up_at, last_synced_at
                    ) VALUES %s
                """, tuples,
                template="(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
                         "(NOW() AT TIME ZONE 'Asia/Kolkata')::DATE, NOW())",
                page_size=500)

                print("bumping oh_id_counter ...")
                for code, (counter, suffix) in new_counters.items():
                    cur.execute("UPDATE oh_id_counter SET counter = %s, suffix = %s WHERE city_code = %s",
                                (counter, suffix, code))

            if update_records:
                print(f"bulk UPDATE for {len(update_records)} pre-existing rows ...")
                # Update via temp table for speed.
                cur.execute("""
                    CREATE TEMP TABLE _bulk_upd (
                        listing_link TEXT PRIMARY KEY,
                        source TEXT, city TEXT, locality TEXT, society TEXT,
                        bedrooms INT, area_sqft INT, floor TEXT, price BIGINT,
                        seller_name TEXT, posting_date DATE
                    ) ON COMMIT DROP
                """)
                upd_tuples = [
                    (r["listing_link"], r["source"], r["city"], r["locality"], r["society"],
                     r["bedrooms"], r["area_sqft"], r["floor"], r["price"],
                     r["seller_name"], r["posting_date"])
                    for r in update_records
                ]
                execute_values(cur, """
                    INSERT INTO _bulk_upd (listing_link, source, city, locality, society,
                                           bedrooms, area_sqft, floor, price, seller_name, posting_date)
                    VALUES %s
                """, upd_tuples, page_size=500)
                cur.execute("""
                    UPDATE inventory i SET
                        source = u.source, city = u.city, locality = u.locality, society = u.society,
                        bedrooms = u.bedrooms, area_sqft = u.area_sqft, floor = u.floor,
                        price = u.price, seller_name = u.seller_name, posting_date = u.posting_date,
                        last_synced_at = NOW()
                    FROM _bulk_upd u
                    WHERE i.listing_link = u.listing_link
                """)

            cur.execute("INSERT INTO activity_log (actor_email, entity_type, action, metadata) "
                        "VALUES (%s, 'sync', 'bulk_seed', %s::jsonb)",
                        ("system:bulk_seed",
                         f'{{"inserted": {len(tuples)}, "updated": {len(update_records)}, "skipped": {skipped}, "csv": "{csv_path}"}}'))

        conn.commit()
        elapsed = time.time() - started
        print(f"\nDONE in {elapsed:.1f}s — inserted={len(tuples)}, updated={len(update_records)}, skipped={skipped}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python -m backend.scripts.bulk_seed path/to/sheet_export.csv")
        sys.exit(1)
    main(sys.argv[1])
