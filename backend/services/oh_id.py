"""OH-ID generator for Direct Inventory Portal.

Format: OHL{CITY}D{NNNN}{SUFFIX}
  CITY:   G | N | GH
  NNNN:   0001..9999 zero-padded
  SUFFIX: '' on the first sweep, then 'A', 'B', 'C' ... when 9999 rolls over.

Counter state lives in `oh_id_counter` (one row per city). Calls to next_oh_id
take a row-level lock to serialize concurrent inserts.
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

CITY_TO_CODE = {
    "noida": "N",
    "greater noida": "N",      # treated as Noida for OH-ID purposes
    "gurgaon": "G",
    "gurugram": "G",
    "ghaziabad": "GH",
}


def city_code(city: str) -> str:
    if not city:
        raise ValueError("city is required for OH-ID generation")
    code = CITY_TO_CODE.get(city.strip().lower())
    if not code:
        raise ValueError(f"unknown city for OH-ID: {city!r}")
    return code


def _next_suffix(suffix: str) -> str:
    """'' -> 'A', 'A' -> 'B', ..., 'Z' -> 'AA' (defensive; we expect to never reach 'Z')."""
    if suffix == "":
        return "A"
    if len(suffix) == 1 and suffix < "Z":
        return chr(ord(suffix) + 1)
    if suffix == "Z":
        return "AA"
    # General base-26 increment for AA, AB, ... — defensive only.
    chars = list(suffix)
    i = len(chars) - 1
    while i >= 0:
        if chars[i] < "Z":
            chars[i] = chr(ord(chars[i]) + 1)
            return "".join(chars)
        chars[i] = "A"
        i -= 1
    return "A" + "".join(chars)


def format_oh_id(code: str, counter: int, suffix: str) -> str:
    return f"OHL{code}D{counter:04d}{suffix}"


def next_oh_id(cur, city: str) -> str:
    """Allocate the next OH-ID for `city`. Caller owns the transaction.

    Uses SELECT ... FOR UPDATE to serialize across concurrent transactions.
    """
    code = city_code(city)
    cur.execute(
        "SELECT counter, suffix FROM oh_id_counter WHERE city_code = %s FOR UPDATE",
        (code,),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"oh_id_counter row missing for city_code={code!r} — run migrations")
    # Cursor is a RealDictCursor (see db.py), so rows are dicts not tuples.
    counter, suffix = row["counter"], row["suffix"]

    counter += 1
    if counter > 9999:
        counter = 1
        suffix = _next_suffix(suffix)

    cur.execute(
        "UPDATE oh_id_counter SET counter = %s, suffix = %s WHERE city_code = %s",
        (counter, suffix, code),
    )
    return format_oh_id(code, counter, suffix)


def backfill_missing_oh_ids(conn) -> dict:
    """Assign an oh_id to every inventory row that's missing one.

    "Missing" = NULL or empty string. Allocates via next_oh_id (per-city
    counter, row-locked). Rows without a usable city are skipped because
    next_oh_id can't generate an ID for them.

    Caller owns transaction commit. Returns counts for visibility.
    """
    filled = skipped = 0
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, city FROM inventory "
            "WHERE oh_id IS NULL OR oh_id = '' "
            "ORDER BY id "
            "FOR UPDATE"
        )
        rows = cur.fetchall()
        for r in rows:
            city = r.get("city")
            if not city:
                skipped += 1
                continue
            try:
                new_id = next_oh_id(cur, city)
            except (ValueError, RuntimeError) as e:
                log.warning("oh_id backfill skipped id=%s: %s", r["id"], e)
                skipped += 1
                continue
            cur.execute(
                "UPDATE inventory SET oh_id = %s WHERE id = %s",
                (new_id, r["id"]),
            )
            filled += 1
    return {"filled": filled, "skipped": skipped}
