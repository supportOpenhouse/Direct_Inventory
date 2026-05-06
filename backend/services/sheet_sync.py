"""Push-based sync: an Apps Script (daily trigger) POSTs sheet rows to /api/sync/sheet.

The backend just receives JSON, dedups by listing_link, upserts raw fields,
assigns OH-IDs + RMs to new rows. Workflow fields (stage, notes, assignments,
oh_id) are NEVER touched by sync. Removed-from-sheet rows stay in the DB.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from .activity import log as log_activity
from .assignment import resolve_assignment
from .oh_id import next_oh_id

log = logging.getLogger(__name__)

REQUIRED_FIELDS = [
    "source", "city", "locality", "society", "bedrooms", "area_sqft",
    "floor", "price", "seller_name", "posting_date", "listing_link",
]


def _normalize_key(k: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (k or "").strip().lower()).strip("_")


def _parse_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _parse_date(v) -> str | None:
    if not v:
        return None
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _normalize_row(raw: dict) -> dict | None:
    """Normalize keys + types. Returns None if listing_link is empty (must dedup on it)."""
    rec = {_normalize_key(k): v for k, v in raw.items()}

    listing = (rec.get("listing_link") or "").strip()
    if not listing:
        return None

    return {
        "source":       (rec.get("source") or "").strip() or None,
        "city":         (rec.get("city") or "").strip() or None,
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


def run_push_sync(conn, rows: list[dict], *, actor_email: str = "system:apps-script") -> dict:
    """Run sync from a pushed payload. Caller provides the DB connection.

    Args:
        rows: list of dicts. Keys may be raw header names from the sheet
              (we normalize them) or already-normalized snake_case fields.

    Returns:
        Summary: { fetched, inserted, updated, skipped, errors }.
    """
    started = datetime.now(tz=timezone.utc)
    fetched = len(rows)
    inserted = updated = skipped = errors = 0

    with conn, conn.cursor() as cur:
        for raw in rows:
            try:
                rec = _normalize_row(raw)
                if not rec or not rec["city"] or not rec["listing_link"]:
                    skipped += 1
                    continue

                cur.execute(
                    "SELECT oh_id FROM inventory WHERE listing_link = %s",
                    (rec["listing_link"],),
                )
                existing = cur.fetchone()
                if existing:
                    cur.execute(
                        """
                        UPDATE inventory SET
                            source = %s, city = %s, locality = %s, society = %s,
                            bedrooms = %s, area_sqft = %s, floor = %s, price = %s,
                            seller_name = %s, posting_date = %s,
                            last_synced_at = NOW()
                        WHERE listing_link = %s
                        """,
                        (
                            rec["source"], rec["city"], rec["locality"], rec["society"],
                            rec["bedrooms"], rec["area_sqft"], rec["floor"], rec["price"],
                            rec["seller_name"], rec["posting_date"], rec["listing_link"],
                        ),
                    )
                    updated += 1
                    continue

                oh_id = next_oh_id(cur, rec["city"])
                rm_id, mgr_id = resolve_assignment(
                    cur, city=rec["city"], locality=rec["locality"], society=rec["society"],
                )
                cur.execute(
                    """
                    INSERT INTO inventory (
                        oh_id, source, city, locality, society, bedrooms, area_sqft,
                        floor, price, seller_name, posting_date, listing_link,
                        stage, assigned_rm_id, assigned_mgr_id, last_synced_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                              'qualified', %s, %s, NOW())
                    """,
                    (
                        oh_id, rec["source"], rec["city"], rec["locality"], rec["society"],
                        rec["bedrooms"], rec["area_sqft"], rec["floor"], rec["price"],
                        rec["seller_name"], rec["posting_date"], rec["listing_link"],
                        rm_id, mgr_id,
                    ),
                )
                inserted += 1
            except Exception:
                log.exception("sync row failed")
                errors += 1

        log_activity(
            cur,
            actor_user_id=None,
            actor_email=actor_email,
            entity_type="sync",
            entity_id=None,
            action="sync_run",
            metadata={
                "fetched": fetched, "inserted": inserted, "updated": updated,
                "skipped": skipped, "errors": errors,
                "duration_ms": int((datetime.now(tz=timezone.utc) - started).total_seconds() * 1000),
            },
        )

    return {"fetched": fetched, "inserted": inserted, "updated": updated,
            "skipped": skipped, "errors": errors}
