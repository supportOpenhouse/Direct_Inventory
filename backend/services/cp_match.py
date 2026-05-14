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
  - backfill_one_chunk(conn, cursor) — admin-triggered: scan ONE chunk of
    inventory rows starting after `cursor`; frontend loops until done. Keeps
    each HTTP request well under any proxy/gateway timeout.
"""
from __future__ import annotations

import logging

from psycopg2.extras import execute_values

from .. import config
from ..db import get_cp_conn

log = logging.getLogger(__name__)

BATCH_SIZE = 2000


def _norm(v) -> str:
    return (str(v).strip().lower() if v not in (None, "") else "")


def _norm_bhk(v) -> str | None:
    """bhk lives as varchar in CP DB but int in Direct — normalize to a
    stripped string on both sides so dict-keys and SQL params line up. Returns
    None for missing values (caller skips classification)."""
    if v is None or v == "":
        return None
    return str(v).strip()


def _classify(direct_row: dict, cp_index: dict[tuple, set]) -> str | None:
    s = _norm(direct_row.get("society"))
    b = _norm_bhk(direct_row.get("bedrooms"))
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
        f"       TRIM(bhk::TEXT) AS b, "
        f"       LOWER(TRIM(COALESCE(floor::TEXT, ''))) AS f, "
        f"       LOWER(TRIM(COALESCE(tower::TEXT, ''))) AS t, "
        f"       LOWER(TRIM(COALESCE(unit_no::TEXT, ''))) AS u "
        f"FROM {config.CP_INVENTORY_TABLE} "
        f"WHERE (LOWER(TRIM(society_name)), TRIM(bhk::TEXT), "
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
        b = _norm_bhk(r.get("bedrooms"))
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


def backfill_one_chunk(conn, cursor: str) -> dict:
    """Scan ONE chunk of inventory rows (oh_id > cursor), classify, persist.

    Returns:
      { done, next_cursor, perfect, partial, no_match, processed }

    `done` is True when this chunk had fewer than BATCH_SIZE rows (i.e. the
    table is exhausted). The frontend loops, passing back `next_cursor` each
    time, until `done` is True — this keeps every HTTP request small enough
    to survive any proxy/gateway timeout, regardless of total table size.

    Raises if CP_DB_URL is unset.
    """
    if not config.CP_DB_URL:
        raise RuntimeError("CP_DB_URL is not set — cannot run scan")

    perfect = partial = none = 0

    with conn.cursor() as cur:
        cur.execute(
            "SELECT oh_id, society, bedrooms, floor, tower, unit_no "
            "FROM inventory WHERE oh_id > %s "
            "ORDER BY oh_id LIMIT %s",
            (cursor, BATCH_SIZE),
        )
        rows = cur.fetchall()
        if not rows:
            return {"done": True, "next_cursor": cursor,
                    "perfect": 0, "partial": 0, "no_match": 0, "processed": 0}

        keys = set()
        for r in rows:
            s = _norm(r.get("society"))
            b = _norm_bhk(r.get("bedrooms"))
            f = _norm(r.get("floor"))
            if s and b is not None:
                keys.add((s, b, f))
        cp_index = _query_cp(keys)

        verdicts = []
        for r in rows:
            # 'none' (not NULL) — distinguishes "scanned and no match found"
            # from "never scanned yet". NULL is reserved for the latter
            # (set by PATCH when a match-input field changes).
            verdict = _classify(r, cp_index) or "none"
            verdicts.append((r["oh_id"], verdict))
            if verdict == "perfect": perfect += 1
            elif verdict == "partial": partial += 1
            else: none += 1

        # Single bulk UPDATE — one round-trip instead of BATCH_SIZE.
        execute_values(
            cur,
            "UPDATE inventory AS i SET cp_match = v.verdict "
            "FROM (VALUES %s) AS v(oh_id, verdict) "
            "WHERE i.oh_id = v.oh_id",
            verdicts, page_size=BATCH_SIZE,
        )

        last_oh_id = rows[-1]["oh_id"]
    conn.commit()

    done = len(rows) < BATCH_SIZE
    log.info("cp_match chunk: cursor<=%s processed=%d perfect=%d partial=%d no_match=%d done=%s",
             last_oh_id, len(rows), perfect, partial, none, done)

    return {
        "done": done,
        "next_cursor": last_oh_id,
        "perfect": perfect,
        "partial": partial,
        "no_match": none,
        "processed": len(rows),
    }


# Fields whose change invalidates the persisted cp_match verdict.
MATCH_INPUT_FIELDS = {"society", "bedrooms", "floor", "tower", "unit_no"}
