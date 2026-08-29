"""One-off: upload the CP Inventory Master CSV as new `lead` rows.

Refinement, in order:
  1. Dedup by seller phone (keep the first row for each 10-digit number; rows with
     no usable phone are all kept).
  2. Clamp Asking: keep only ₹40,00,000–₹5,00,00,000 (4e6–5e7); anything outside
     (or unparseable) → price left EMPTY. The lead is still uploaded.
  3. Rename CSV columns → inventory columns (Occupancy + Owner Email are dropped —
     no columns for them).

Insert mirrors services/sheet_sync.py: per-row OH-ID (next_oh_id) + RM/manager
resolution (resolve_assignment), stage='lead', a synthetic internal listing_link
(the UNIQUE dedup key), follow_up_at = today IST.

Usage (from repo root):
    python -m backend.scripts.upload_cp_master                 # dry-run preview
    python -m backend.scripts.upload_cp_master --commit        # actually insert
    python -m backend.scripts.upload_cp_master path/to.csv --commit
"""
from __future__ import annotations

import csv
import os
import re
import sys

from ..db import get_conn
from ..services.assignment import resolve_assignment
from ..services.oh_id import next_oh_id

PRICE_MIN = 4_000_000     # ₹40,00,000
PRICE_MAX = 50_000_000    # ₹5,00,00,000
DEFAULT_CSV = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "CP_Inventory_Master - Sahaj.csv",
)
SOURCE = "CP Inventory Master"


def _phone(v: str) -> str | None:
    digits = re.sub(r"\D", "", v or "")
    if len(digits) >= 10:
        return digits[-10:]
    return None  # too short to be a usable/dedupable number


def _num(v: str):
    """'1,545' -> 1545, '3.5' -> 3.5, '' -> None."""
    s = re.sub(r"[^\d.]", "", (v or "").strip())
    if not s:
        return None
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return None


def _price(v: str):
    n = _num(v)
    if n is None:
        return None
    return n if PRICE_MIN <= n <= PRICE_MAX else None  # out of range → empty


def _txt(v: str):
    s = (v or "").strip()
    return s or None


def refine(path: str) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    seen_phones: set[str] = set()
    out: list[dict] = []
    for i, r in enumerate(rows):
        phone = _phone(r.get("Owner Mobile (Subvention)", ""))
        if phone and phone in seen_phones:
            continue  # dedup on phone
        if phone:
            seen_phones.add(phone)
        city = _txt(r.get("City")) or ""
        if not city:
            continue  # city is NOT NULL — skip a row with no city
        # Unique listing_link (dedup key): phone if we have one, else row index.
        link = f"internal://cp-master/{phone or f'row{i}'}"
        out.append({
            "city": city,
            "society": _txt(r.get("Society")),
            "tower": _txt(r.get("Tower")),
            "unit_no": _txt(r.get("Unit")),
            "floor": _txt(r.get("Floor")),
            "bedrooms": _num(r.get("BHK")),
            "area_sqft": _num(r.get("Sqft")),
            "price": _price(r.get("Asking")),
            "seller_name": _txt(r.get("Owner Name (Subvention)")),
            "seller_phone": phone,
            "listing_link": link,
        })
    return out


def main() -> int:
    args = [a for a in sys.argv[1:]]
    commit = "--commit" in args
    paths = [a for a in args if not a.startswith("--")]
    path = paths[0] if paths else DEFAULT_CSV
    if not os.path.exists(path):
        print(f"CSV not found: {path}", file=sys.stderr)
        return 2

    recs = refine(path)
    print(f"Refined {len(recs)} rows (after phone-dedup + city filter).")
    priced = sum(1 for r in recs if r["price"] is not None)
    print(f"  {priced} in price range, {len(recs) - priced} with price left empty.")

    if not commit:
        print("\nDRY RUN — first 5 refined rows:")
        for r in recs[:5]:
            print(f"  {r['city']:<12} {str(r['society'])[:22]:<22} "
                  f"{r['bedrooms']}BHK {r['area_sqft']}sqft  ₹{r['price']}  "
                  f"{r['seller_name']}  {r['seller_phone']}")
        print("\nRe-run with --commit to insert.")
        return 0

    conn = get_conn()
    inserted = skipped = failed = 0
    try:
        with conn, conn.cursor() as cur:
            for r in recs:
                try:
                    cur.execute("SAVEPOINT row_save")
                    cur.execute("SELECT 1 FROM inventory WHERE listing_link = %s", (r["listing_link"],))
                    if cur.fetchone():
                        skipped += 1
                        cur.execute("RELEASE SAVEPOINT row_save")
                        continue
                    oh_id = next_oh_id(cur, r["city"])
                    rm_id, mgr_id = resolve_assignment(
                        cur, city=r["city"], locality=None, society=r["society"],
                    )
                    cur.execute(
                        """
                        INSERT INTO inventory (
                            oh_id, source, city, society, bedrooms, area_sqft,
                            floor, tower, unit_no,
                            price, seller_name, seller_phone, listing_link,
                            stage, assigned_rm_ids, assigned_mgr_id, follow_up_at, last_synced_at
                        ) VALUES (%s, %s, %s, %s, %s, %s,
                                  %s, %s, %s,
                                  %s, %s, %s, %s,
                                  'lead', %s, %s,
                                  (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE, NOW())
                        """,
                        (
                            oh_id, SOURCE, r["city"], r["society"], r["bedrooms"], r["area_sqft"],
                            r["floor"], r["tower"], r["unit_no"],
                            r["price"], r["seller_name"], r["seller_phone"], r["listing_link"],
                            [rm_id] if rm_id else [], mgr_id,
                        ),
                    )
                    cur.execute("RELEASE SAVEPOINT row_save")
                    inserted += 1
                except Exception as e:  # noqa: BLE001 — one bad row shouldn't sink the batch
                    cur.execute("ROLLBACK TO SAVEPOINT row_save")
                    cur.execute("RELEASE SAVEPOINT row_save")
                    failed += 1
                    print(f"  row failed ({r.get('seller_phone')}): {type(e).__name__}: {e}", file=sys.stderr)
    finally:
        conn.close()

    print(f"\nDone. inserted={inserted}  skipped(existing)={skipped}  failed={failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
