"""CP Inventory match annotation.

For a batch of Direct Inventory rows, look up matches in the CP Inventory
Portal DB and annotate each row with `cp_match`:

  'perfect' — society + bhk + floor + tower + unit_no all match
  'partial' — society + bhk + floor match (but not tower+unit_no)
  None      — no match found, or CP DB not configured / unreachable.

CP DB connection is read-only; failure to reach it is non-fatal.

Two entry points:
  - annotate_cp_match(rows) — mutate in-memory rows (used by the list endpoint
    as a fallback for rows that haven't been scanned yet).
  - backfill_all_matches(conn) — admin-triggered: scan every inventory row
    in chunks and persist the result on `inventory.cp_match`.
"""
from __future__ import annotations

import logging

from .. import config
from ..db import get_cp_conn

log = logging.getLogger(__name__)

BATCH_SIZE = 500


def _norm(v) -> str:
    return (str(v).strip().lower() if v not in (None, "") else "")


def _classify(direct_row: dict, cp_index: dict[tuple, set]) -> str | None:
    s = _norm(direct_row.get("society"))
    b = direct_row.get("bedrooms")
    f = _norm(direct_row.get("floor"))
    if not s or b is None:
        return None
    cp_set = cp_index.get((s, b, f))
    if not cp_set:
        return None
    t = _norm(direct_row.get("tower"))
    u = _norm(direct_row.get("unit_no"))
    if t and u and (t, u) in cp_set:
        return "perfect"
    return "partial"


def _query_cp(keys: set) -> dict[tuple, set]:
    """Run one CP-DB query for the given set of (society, bhk, floor) keys.
    Returns: { (s,b,f): {(tower, unit_no), ...} }
    """
    if not keys:
        return {}
    placeholders = ",".join(["(%s,%s,%s)"] * len(keys))
    flat: list = []
    for s, b, f in keys:
        flat.extend([s, b, f])
    sql = (
        f"SELECT LOWER(TRIM(society_name)) AS s, "
        f"       bhk AS b, "
        f"       LOWER(TRIM(COALESCE(floor::TEXT, ''))) AS f, "
        f"       LOWER(TRIM(COALESCE(tower::TEXT, ''))) AS t, "
        f"       LOWER(TRIM(COALESCE(unit_no::TEXT, ''))) AS u "
        f"FROM {config.CP_INVENTORY_TABLE} "
        f"WHERE (LOWER(TRIM(society_name)), bhk, "
        f"       LOWER(TRIM(COALESCE(floor::TEXT, '')))) "
        f"  IN ({placeholders})"
    )
    conn = None
    try:
        conn = get_cp_conn()
        if conn is None:
            return {}
        with conn, conn.cursor() as cur:
            cur.execute(sql, flat)
            cp_rows = cur.fetchall()
    finally:
        if conn is not None:
            try: conn.close()
            except Exception: pass

    index: dict[tuple, set] = {}
    for cp in cp_rows:
        key = (cp["s"], cp["b"], cp["f"])
        index.setdefault(key, set()).add((cp["t"], cp["u"]))
    return index


def annotate_cp_match(rows: list[dict]) -> None:
    """Fill `cp_match` for any row that doesn't already have it persisted.

    Rows with a non-None `cp_match` keep their value (it came from the persisted
    column on the inventory row). Rows with None get classified via a single
    batched CP-DB query. Failure is non-fatal — those rows just stay None.
    """
    todo = [r for r in rows if r.get("cp_match") is None]
    if not config.CP_DB_URL or not todo:
        return

    keys = set()
    for r in todo:
        s = _norm(r.get("society"))
        b = r.get("bedrooms")
        f = _norm(r.get("floor"))
        if s and b is not None:
            keys.add((s, b, f))

    try:
        index = _query_cp(keys)
    except Exception:
        log.exception("CP match lookup failed — leaving cp_match=None on these rows")
        return

    for r in todo:
        r["cp_match"] = _classify(r, index) or "none"


def backfill_all_matches(conn) -> dict:
    """Scan EVERY inventory row, classify against CP, persist `cp_match`.

    Iterates in keyset-paginated chunks of BATCH_SIZE and commits per chunk
    so a mid-flight failure leaves the DB in a partial-but-consistent state
    rather than rolling back everything.

    Returns: { total, perfect, partial, no_match }.
    Raises if CP_DB_URL is unset.
    """
    if not config.CP_DB_URL:
        raise RuntimeError("CP_DB_URL is not set — cannot run scan")

    total = perfect = partial = none = 0
    last_oh_id = ""

    while True:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT oh_id, society, bedrooms, floor, tower, unit_no "
                "FROM inventory WHERE oh_id > %s "
                "ORDER BY oh_id LIMIT %s",
                (last_oh_id, BATCH_SIZE),
            )
            rows = cur.fetchall()
            if not rows:
                break

            keys = set()
            for r in rows:
                s = _norm(r.get("society"))
                b = r.get("bedrooms")
                f = _norm(r.get("floor"))
                if s and b is not None:
                    keys.add((s, b, f))
            cp_index = _query_cp(keys)

            for r in rows:
                # 'none' (not NULL) — distinguishes "scanned and no match found"
                # from "never scanned yet". NULL is reserved for the latter
                # (set by PATCH when a match-input field changes).
                verdict = _classify(r, cp_index) or "none"
                cur.execute(
                    "UPDATE inventory SET cp_match = %s WHERE oh_id = %s",
                    (verdict, r["oh_id"]),
                )
                if verdict == "perfect": perfect += 1
                elif verdict == "partial": partial += 1
                else: none += 1
                total += 1

            last_oh_id = rows[-1]["oh_id"]
        conn.commit()
        log.info("cp_match backfill chunk: oh_id<=%s, running totals: total=%d perfect=%d partial=%d no_match=%d",
                 last_oh_id, total, perfect, partial, none)

    return {"total": total, "perfect": perfect, "partial": partial, "no_match": none}


# Fields whose change invalidates the persisted cp_match verdict.
MATCH_INPUT_FIELDS = {"society", "bedrooms", "floor", "tower", "unit_no"}
