"""CP Inventory match annotation.

For a batch of Direct Inventory rows, look up matches in the CP Inventory
Portal DB and annotate each row with `cp_match`:

  'perfect' — society + bhk match, AND floor (if matchable on both sides)
              AND tower + unit_no all match in CP.
  'partial' — society + bhk match in CP, but the unit-level identifiers
              (floor / tower / unit_no) don't all line up.
  None      — no match found, or CP DB not configured / unreachable.

Normalization quirks worth knowing:
  - bhk: CP stores '2 BHK' / '3 BHK', Direct stores the integer 2. Both
    sides reduce to leading digits ('2 BHK' → '2', 2 → '2').
  - floor: CP often uses bucket labels ('Higher', 'Middle', 'Lower') that
    can't be reconciled with Direct's exact floor number. A floor value
    participates in matching only if it's an integer in [1, 50] or the
    literal 'Top'. Otherwise floor is skipped and we lean on tower/unit_no.
  - area: when floor is skipped, area_sqft acts as a sanity check — if
    both sides have an area value, they must be within ±25 sqft. This
    prevents matching against a structurally different unit in the same
    (society, bhk) bucket when floor data is unusable.

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
from .oh_id import backfill_missing_oh_ids

log = logging.getLogger(__name__)

BATCH_SIZE = 2000


def _norm(v) -> str:
    return (str(v).strip().lower() if v not in (None, "") else "")


def _norm_bhk(v) -> str | None:
    """Reduce '2', '2 BHK', '2BHK', '2.0', 2 → '2'. Anything without a leading
    digit (e.g. 'Studio') → None, meaning unmatchable."""
    if v is None or v == "":
        return None
    s = str(v).strip()
    digits = ""
    for ch in s:
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits or None


def _floor_matchable(f: str) -> bool:
    """True if this floor value can participate in matching.

    Matchable: an integer 1-50, or the literal 'top'. Anything else
    (bucket labels like 'higher'/'middle'/'lower', empty, garbage) → skip.
    """
    if f == "top":
        return True
    try:
        n = int(f)
    except (ValueError, TypeError):
        return False
    return 1 <= n <= 50


AREA_TOLERANCE_SQFT = 25


def _area_compatible(d_area, cp_area) -> bool:
    """Sanity check used only when floor isn't reliable. Returns True if
    either side's area is missing (skip the check) or both are present and
    within ±AREA_TOLERANCE_SQFT.
    """
    if d_area is None or cp_area is None:
        return True
    try:
        return abs(float(d_area) - float(cp_area)) <= AREA_TOLERANCE_SQFT
    except (ValueError, TypeError):
        return True


def _unit_compatible(d_floor: str, cp_floor: str, d_area, cp_area) -> bool:
    """A CP candidate is "same physical unit"-compatible with a Direct row if:
      - both floors are matchable values that are equal, OR
      - at least one floor is non-matchable (skip floor) AND areas are within
        ±AREA_TOLERANCE_SQFT (or either area is missing).
    """
    if _floor_matchable(d_floor) and _floor_matchable(cp_floor):
        return d_floor == cp_floor
    return _area_compatible(d_area, cp_area)


def _classify(direct_row: dict, cp_index: dict[tuple, list[tuple]]) -> str | None:
    """Classify one Direct row against the pre-built CP index.

    Index shape: { (society, bhk): [(floor, tower, unit_no, area), ...] }

    Returns 'perfect' | 'partial' | None.
    """
    s = _norm(direct_row.get("society"))
    b = _norm_bhk(direct_row.get("bedrooms"))
    if not s or b is None:
        return None
    candidates = cp_index.get((s, b))
    if not candidates:
        return None

    d_floor = _norm(direct_row.get("floor"))
    d_tower = _norm(direct_row.get("tower"))
    d_unit = _norm(direct_row.get("unit_no"))
    d_area = direct_row.get("area_sqft")

    any_partial = False
    for cf, ct, cu, ca in candidates:
        if not _unit_compatible(d_floor, cf, d_area, ca):
            continue
        if d_tower and d_unit and d_tower == ct and d_unit == cu:
            return "perfect"
        any_partial = True

    return "partial" if any_partial else None


def _query_cp(keys: set) -> dict[tuple, list[tuple]]:
    """Run one CP-DB query for the given set of (society, bhk) keys.

    Returns: { (s, b): [(floor, tower, unit_no, area), ...] }

    `area` is the raw CP area_sqft (REAL) — kept numeric for the ±25 sqft
    tolerance check in _classify. Both sides normalize bhk to leading digits.
    """
    if not keys:
        return {}
    placeholders = ",".join(["(%s,%s)"] * len(keys))
    flat: list = []
    for s, b in keys:
        flat.extend([s, b])
    # SUBSTRING(... FROM '^[0-9]+') extracts the leading digits — same logic
    # as _norm_bhk on the Python side. NULL (e.g. bhk='Studio') is unmatchable.
    sql = (
        f"SELECT LOWER(TRIM(society_name)) AS s, "
        f"       SUBSTRING(bhk::TEXT FROM '^[0-9]+') AS b, "
        f"       LOWER(TRIM(COALESCE(floor::TEXT, ''))) AS f, "
        f"       LOWER(TRIM(COALESCE(tower::TEXT, ''))) AS t, "
        f"       LOWER(TRIM(COALESCE(unit_no::TEXT, ''))) AS u, "
        f"       area_sqft AS a "
        f"FROM {config.CP_INVENTORY_TABLE} "
        f"WHERE (LOWER(TRIM(society_name)), SUBSTRING(bhk::TEXT FROM '^[0-9]+')) "
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

    index: dict[tuple, list[tuple]] = {}
    for cp in cp_rows:
        key = (cp["s"], cp["b"])
        index.setdefault(key, []).append((cp["f"], cp["t"], cp["u"], cp["a"]))
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
        if s and b is not None:
            keys.add((s, b))

    try:
        index = _query_cp(keys)
    except Exception:
        log.exception("CP match lookup failed — leaving cp_match=None on these rows")
        return

    for r in todo:
        r["cp_match"] = _classify(r, index) or "none"


def backfill_one_chunk(conn, cursor: str) -> dict:
    """Scan ONE chunk of UNSCANNED inventory rows (cp_match IS NULL), classify,
    persist.

    Only rows whose verdict isn't set yet are processed; rows already labeled
    'perfect'/'partial'/'none' are left alone. A PATCH on any match-input field
    (see MATCH_INPUT_FIELDS) sets cp_match back to NULL, so edited rows get
    re-evaluated on the next scan. To force a full rescan, run
    `UPDATE inventory SET cp_match = NULL` first.

    Returns:
      { done, next_cursor, perfect, partial, no_match, processed }

    `done` is True when this chunk had fewer than BATCH_SIZE rows (i.e. no
    more NULL rows past `cursor`). The frontend loops, passing back
    `next_cursor` each time, until `done` is True — this keeps every HTTP
    request small enough to survive any proxy/gateway timeout regardless of
    table size.

    Raises if CP_DB_URL is unset.
    """
    if not config.CP_DB_URL:
        raise RuntimeError("CP_DB_URL is not set — cannot run scan")

    # First-chunk-only: backfill any rows missing an oh_id. Has to run BEFORE
    # the cp_match work below because that loop paginates on `oh_id > cursor`
    # — rows with NULL/empty oh_id are invisible to it otherwise.
    oh_id_fill = {"filled": 0, "skipped": 0}
    if cursor == "":
        oh_id_fill = backfill_missing_oh_ids(conn)
        if oh_id_fill["filled"] or oh_id_fill["skipped"]:
            log.info("oh_id backfill: filled=%d skipped=%d",
                     oh_id_fill["filled"], oh_id_fill["skipped"])
        conn.commit()

    perfect = partial = none = 0

    with conn.cursor() as cur:
        # Only re-scan rows whose verdict hasn't been set yet (NULL means
        # "never scanned" or "invalidated by a recent PATCH to a match-input
        # field"). Rows already labeled 'perfect'/'partial'/'none' are left
        # alone — a PATCH on society/bedrooms/floor/tower/unit_no sets the
        # column back to NULL, so they'll get picked up on the next run.
        cur.execute(
            "SELECT oh_id, society, bedrooms, floor, tower, unit_no, area_sqft "
            "FROM inventory WHERE oh_id > %s AND cp_match IS NULL "
            "ORDER BY oh_id LIMIT %s",
            (cursor, BATCH_SIZE),
        )
        rows = cur.fetchall()
        if not rows:
            return {"done": True, "next_cursor": cursor,
                    "perfect": 0, "partial": 0, "no_match": 0, "processed": 0,
                    "oh_ids_filled": oh_id_fill["filled"],
                    "oh_ids_skipped": oh_id_fill["skipped"]}

        keys = set()
        for r in rows:
            s = _norm(r.get("society"))
            b = _norm_bhk(r.get("bedrooms"))
            if s and b is not None:
                keys.add((s, b))
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
        "oh_ids_filled": oh_id_fill["filled"],
        "oh_ids_skipped": oh_id_fill["skipped"],
    }


# Fields whose change invalidates the persisted cp_match verdict.
MATCH_INPUT_FIELDS = {"society", "bedrooms", "floor", "tower", "unit_no"}
