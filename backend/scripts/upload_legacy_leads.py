"""Upload legacy CSV leads into inventory as qualified leads.

CSV columns (header): source, city, locality, society, bedrooms, area_sqft,
floor, price, listing_id, seller_name, phone number
  - `listing_id` actually holds the listing URL → inventory.listing_link.
  - `price` is in LAKHS → stored as INR (× 100000).
  - `phone number` → inventory.seller_phone (digits only).
  - locality '[to be updated]' / blanks → NULL (the daily locality backfill fills it).
  - blank numeric / 0 price → NULL.

oh_id: OHLND####LEG (e.g. OHLND0001LEG), numbered from one past the highest
existing …LEG id, so a re-run appends rather than colliding. First run on a DB
with no LEG rows starts at OHLND0001LEG.

listing_link is NOT NULL UNIQUE: rows with no URL (or a URL already in the DB)
get a unique internal://legacy/<oh_id> instead, so every row still lands with
its oh_id — nothing is silently dropped.

Run (from repo root):
    backend/.venv/bin/python -m backend.scripts.upload_legacy_leads "Legacy data - Sheet4.csv"
    backend/.venv/bin/python -m backend.scripts.upload_legacy_leads "Legacy data - Sheet4.csv" --dry
    backend/.venv/bin/python -m backend.scripts.upload_legacy_leads --selftest   # parser check, no DB
"""
from __future__ import annotations

import csv
import os
import re
import sys

try:
    from dotenv import load_dotenv
    _BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(_BACKEND, ".env"))
except Exception:  # pragma: no cover
    pass

STAGE = "qualified"
COLS = ["oh_id", "source", "city", "locality", "society", "bedrooms", "area_sqft",
        "floor", "price", "seller_name", "seller_phone", "listing_link", "stage"]


def _int(v):
    v = (v or "").replace(",", "").strip()   # tolerate thousands separators, e.g. "1,082"
    return int(float(v)) if v else None


def _text(v):
    v = (v or "").strip()
    return v or None


def parse_row(row, oh_id):
    """One CSV row → a column→value dict ready to INSERT (listing_link filled by
    the caller, which knows about URL collisions)."""
    price_lakhs = (row.get("price") or "").replace(",", "").strip()
    price = None
    if price_lakhs:
        rupees = round(float(price_lakhs) * 100000)
        price = rupees or None            # 0 → NULL (Winners-Data rows carry no price)

    locality = _text(row.get("locality"))
    if locality and locality.lower() == "[to be updated]":
        locality = None

    phone = re.sub(r"\D", "", row.get("phone number") or "") or None

    return {
        "oh_id": oh_id,
        "source": _text(row.get("source")),
        "city": _text(row.get("city")) or "Noida",
        "locality": locality,
        "society": _text(row.get("society")),
        "bedrooms": _int(row.get("bedrooms")),
        "area_sqft": _int(row.get("area_sqft")),
        "floor": _text(row.get("floor")),
        "price": price,
        "seller_name": _text(row.get("seller_name")),
        "seller_phone": phone,
        "listing_link": _text(row.get("listing_id")),   # header 'listing_id' == the URL
        "stage": STAGE,
    }


def _selftest():
    r = parse_row({"source": "99acres", "city": "Noida", "locality": "[to be updated]",
                   "society": "Gaur City 2", "bedrooms": "3", "area_sqft": "1300",
                   "floor": "9", "price": "117", "listing_id": "https://x/1",
                   "seller_name": "Anurag", "phone number": "9654002506"}, "OHLND0001LEG")
    assert r["price"] == 11700000, r["price"]            # 117 lakh → INR
    assert r["locality"] is None                         # placeholder dropped
    assert r["bedrooms"] == 3 and r["area_sqft"] == 1300
    assert r["seller_phone"] == "9654002506"
    assert r["stage"] == "qualified"
    blank = parse_row({"city": "Noida", "society": "Stellar Jeevan", "bedrooms": "",
                       "area_sqft": "1440", "floor": "0", "price": "0",
                       "seller_name": "D MISHRA", "phone number": "8178061817",
                       "listing_id": ""}, "OHLND0002LEG")
    assert blank["price"] is None and blank["bedrooms"] is None   # 0/blank → NULL
    assert blank["floor"] == "0" and blank["source"] is None
    assert blank["listing_link"] is None                          # caller will fill internal://
    comma = parse_row({"area_sqft": "1,082", "price": "1,17", "bedrooms": "3"}, "X")
    assert comma["area_sqft"] == 1082 and comma["price"] == 11700000   # commas stripped
    print("selftest OK")


def main(argv) -> int:
    if "--selftest" in argv:
        _selftest()
        return 0

    dry = "--dry" in argv
    path = next((a for a in argv[1:] if not a.startswith("-")), "Legacy data - Sheet4.csv")
    if not os.path.exists(path):
        print(f"ERROR: CSV not found: {path}", file=sys.stderr)
        return 2

    import psycopg2
    from psycopg2.extras import RealDictCursor
    from psycopg2 import errors

    inv_url = os.environ.get("DATABASE_URL")
    if not inv_url:
        print("ERROR: DATABASE_URL must be set", file=sys.stderr)
        return 2

    with open(path, newline="", encoding="utf-8-sig") as fh:
        rows = [r for r in csv.DictReader(fh) if any((v or "").strip() for v in r.values())]

    conn = psycopg2.connect(inv_url)
    conn.autocommit = False
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(r"SELECT COALESCE(MAX((regexp_replace(oh_id,'\D','','g'))::int),0) AS n "
                        r"FROM inventory WHERE oh_id ~ '^OHLND[0-9]+LEG$'")
            seq = (cur.fetchone()["n"] or 0) + 1

        placeholders = ", ".join(["%s"] * len(COLS))
        insert = f"INSERT INTO inventory ({', '.join(COLS)}) VALUES ({placeholders})"

        inserted = collided = 0
        for row in rows:
            oh_id = f"OHLND{seq:04d}LEG"
            seq += 1
            rec = parse_row(row, oh_id)
            if not rec["listing_link"]:
                rec["listing_link"] = f"internal://legacy/{oh_id}"
            vals = [rec[c] for c in COLS]

            if dry:
                print(f"{oh_id}  {rec['society']:<28} {rec['bedrooms'] or '-'}BHK  "
                      f"₹{(rec['price'] or 0) // 100000}L  link={rec['listing_link'][:48]}")
                inserted += 1
                continue

            try:
                with conn.cursor() as cur:
                    cur.execute(insert, vals)
                conn.commit()
                inserted += 1
            except errors.UniqueViolation:
                # A real URL already in the DB — keep the row, swap to an internal link.
                conn.rollback()
                rec["listing_link"] = f"internal://legacy/{oh_id}"
                vals = [rec[c] for c in COLS]
                with conn.cursor() as cur:
                    cur.execute(insert, vals)
                conn.commit()
                inserted += 1
                collided += 1

        tag = "would insert" if dry else "inserted"
        msg = f"{tag} {inserted} legacy rows as '{STAGE}'"
        if collided:
            msg += f" ({collided} had a duplicate URL → internal link)"
        print(msg, file=sys.stderr)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
