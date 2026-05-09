"""OH Pricing sync — pushed from Apps Script every Friday.

Each push carries one source_sheet's worth of rows (e.g. 'Gurgaon' or 'Noida + GZB').
Sync is per-sheet replace: DELETE all rows for that source_sheet, then INSERT new ones.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from .activity import log as log_activity

log = logging.getLogger(__name__)

# Cities the "Noida + GZB" sheet may contain.
GZB_LIKE_CITIES = {"noida", "greater noida", "ghaziabad"}


def _norm_key(k: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (k or "").strip().lower()).strip("_")


def _parse_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(round(float(str(v).replace(",", "").strip())))
    except (ValueError, TypeError):
        return None


# Columns that hold the OH selling price, in priority order. The 'multiplier' converts
# the raw value to integer rupees: 100_000 for "₹L" (lakhs) columns, 1 for raw ₹.
# Names already pass through _norm_key, so 'Selling Price (₹L)' → 'selling_price_l'.
_PRICE_KEYS_AND_MULTIPLIER = [
    ("oh_price",        1),
    ("oh_pricing",      1),
    ("price",           1),
    ("amount",          1),
    # Lakhs-denominated columns from the actual OH pricing sheets:
    ("selling_price_l", 100_000),    # Gurgaon tab: "★ Selling Price (₹L)"
    ("sell_price_l",    100_000),    # Noida + GZB tab: "Sell Price (₹L)"
]

# Acquisition price columns. Same multiplier convention.
# Per business decision: Gurgaon uses the headline "★ Acq Price (₹L)" (col J);
# Noida + GZB uses the L2 (7% margin) tier from "L2 Acq (₹L)" (col K).
_ACQ_PRICE_KEYS_AND_MULTIPLIER = [
    ("acq_price",      1),
    ("acquisition",    1),
    ("acq_price_l",    100_000),     # Gurgaon tab: "★ Acq Price (₹L)"
    ("l2_acq_l",       100_000),     # Noida + GZB tab: "L2 Acq (₹L)"
]

# Area column candidates in priority order.
_AREA_KEYS = ["area_sqft", "size_sqft", "sqft", "area", "size"]


def _pick_money(rec: dict, candidates) -> int | None:
    """Return the first non-empty money value from `candidates`, ×multiplier."""
    for key, multiplier in candidates:
        v = rec.get(key)
        if v in (None, ""):
            continue
        try:
            f = float(str(v).replace(",", "").strip())
        except (ValueError, TypeError):
            continue
        return int(round(f * multiplier))
    return None


def _normalize_city(raw_city: str | None, default_from_sheet: str | None) -> str | None:
    """Map sheet city values to our canonical cities."""
    s = (raw_city or "").strip().lower()
    if s in {"gurgaon", "gurugram"}:
        return "Gurgaon"
    if s == "noida" or s == "greater noida":
        return s.title()  # 'Noida' or 'Greater Noida'
    if s == "ghaziabad":
        return "Ghaziabad"
    if not s and default_from_sheet:
        # Fall back to sheet-derived default if the row didn't carry city
        if default_from_sheet == "Gurgaon":
            return "Gurgaon"
        # 'Noida + GZB' default → leave NULL so the row is skipped, since we can't tell which one
    return None


def _normalize_row(raw: dict, *, default_city: str | None) -> dict | None:
    """Map a sheet row to a pricing record. Returns None if essentials are missing."""
    rec = {_norm_key(k): v for k, v in raw.items()}

    society = str(rec.get("society") or rec.get("society_name") or rec.get("project") or "").strip()
    if not society:
        return None

    bhk = _parse_int(rec.get("bhk") or rec.get("bedrooms") or rec.get("bedroom"))

    area_sqft = None
    for k in _AREA_KEYS:
        if rec.get(k) not in (None, ""):
            area_sqft = _parse_int(rec.get(k))
            if area_sqft is not None:
                break

    price = _pick_money(rec, _PRICE_KEYS_AND_MULTIPLIER)
    if price is None or price <= 0:
        return None

    acq_price = _pick_money(rec, _ACQ_PRICE_KEYS_AND_MULTIPLIER)
    if acq_price is not None and acq_price <= 0:
        acq_price = None

    city = _normalize_city(rec.get("city"), default_city)
    if not city:
        return None

    return {
        "city": city,
        "society": society,
        "society_norm": society.strip().lower(),
        "bhk": bhk,
        "area_sqft": area_sqft,
        "price": price,
        "acq_price": acq_price,
    }


def run_pricing_sync(
    conn, source_sheet: str, rows: list[dict], *,
    replace_existing: bool = True,
    actor_email: str = "system:apps-script",
) -> dict:
    """Append `rows` to `oh_pricing` for the given `source_sheet`.

    Args:
        source_sheet: 'Gurgaon' or 'Noida + GZB' — used as the per-sheet replace key.
        replace_existing: when True, DELETE rows for this source_sheet before inserting.
            When the Apps Script batches a sync into N POSTs, only the first batch
            should set replace_existing=True; subsequent batches append.
    """
    started = datetime.now(tz=timezone.utc)
    fetched = len(rows)
    inserted = skipped = 0

    default_city = "Gurgaon" if source_sheet.strip().lower() == "gurgaon" else None

    normalized = []
    for raw in rows:
        rec = _normalize_row(raw, default_city=default_city)
        if rec is None:
            skipped += 1
            continue
        normalized.append(rec)

    with conn, conn.cursor() as cur:
        if replace_existing:
            # First batch of a fresh sync: drop everything from this source_sheet.
            cur.execute("DELETE FROM oh_pricing WHERE source_sheet = %s", (source_sheet,))

        if normalized:
            tuples = [
                (source_sheet, r["city"], r["society"], r["society_norm"],
                 r["bhk"], r["area_sqft"], r["price"], r["acq_price"])
                for r in normalized
            ]
            from psycopg2.extras import execute_values
            execute_values(
                cur,
                """INSERT INTO oh_pricing
                   (source_sheet, city, society, society_norm, bhk, area_sqft, price, acq_price)
                   VALUES %s""",
                tuples, page_size=500,
            )
            inserted = len(tuples)

        log_activity(
            cur,
            actor_user_id=None, actor_email=actor_email,
            entity_type="sync", entity_id=None, action="pricing_sync_run",
            metadata={
                "source_sheet": source_sheet,
                "fetched": fetched, "inserted": inserted, "skipped": skipped,
                "duration_ms": int((datetime.now(tz=timezone.utc) - started).total_seconds() * 1000),
            },
        )

    return {"source_sheet": source_sheet, "fetched": fetched, "inserted": inserted, "skipped": skipped}
