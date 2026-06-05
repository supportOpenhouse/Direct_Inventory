"""CP Inventory match annotation.

For a batch of Direct Inventory rows, look up matches in the CP Inventory
Portal DB and annotate each row with `cp_match`:

  'perfect' — society + bhk match, AND floor (if matchable on both sides)
              AND tower + unit_no all match in CP.
  'partial' — society + bhk match in CP, floor/area is compatible, AND it's
              NOT the case that both sides have a full tower+unit but they
              disagree. (When both sides have tower+unit and they differ,
              that's a definitive mismatch, not a partial — counted as none.)
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
  - annotate_cp_match(rows) — Python-side classifier used by the list endpoint
    as a fallback for individual rows that haven't been scanned yet (e.g.
    just inserted, or invalidated by a recent PATCH). One CP-DB query per
    list page; cheap.
  - backfill_one_chunk(conn, cursor) — admin-triggered chunked scan. Each
    call fetches CHUNK_SIZE unscanned inventory rows, queries the CP DB
    once for the (society, bhk) keys in this chunk, classifies in Python,
    bulk-UPDATEs verdicts. Chunking keeps each HTTP request under the Vercel
    edge rewrite timeout (~30s) regardless of total table size; the frontend
    loops until done=true.
"""
from __future__ import annotations

import logging

import psycopg2
from psycopg2.extras import execute_values

from .. import config
from ..db import get_cp_conn

log = logging.getLogger(__name__)

# Set to False once we detect CP_INVENTORY_TABLE has no `area_sqft` column —
# then we stop selecting it and area becomes None for all CP candidates
# (which makes _area_compatible return True, i.e. area is skipped).
_CP_HAS_AREA = True


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
        # Both sides have tower+unit fully populated but they don't match:
        # definitive mismatch, not a partial — skip this candidate.
        if d_tower and d_unit and ct and cu:
            continue
        any_partial = True

    return "partial" if any_partial else None


def _query_cp(keys: set) -> dict[tuple, list[tuple]]:
    """Run one CP-DB query for the given set of (society, bhk) keys.

    Returns: { (s, b): [(floor, tower, unit_no, area), ...] }

    `area` is the raw CP area_sqft (REAL) — kept numeric for the ±25 sqft
    tolerance check in _classify. Both sides normalize bhk to leading digits.
    """
    global _CP_HAS_AREA
    if not keys:
        return {}
    placeholders = ",".join(["(%s,%s)"] * len(keys))
    flat: list = []
    for s, b in keys:
        flat.extend([s, b])

    def _build_sql(include_area: bool) -> str:
        # SUBSTRING(... FROM '^[0-9]+') extracts the leading digits — same
        # logic as _norm_bhk. NULL (e.g. bhk='Studio') stays unmatchable.
        area_col = "       area_sqft AS a " if include_area else "       NULL::REAL AS a "
        return (
            f"SELECT LOWER(TRIM(society_name)) AS s, "
            f"       SUBSTRING(bhk::TEXT FROM '^[0-9]+') AS b, "
            f"       LOWER(TRIM(COALESCE(floor::TEXT, ''))) AS f, "
            f"       LOWER(TRIM(COALESCE(tower::TEXT, ''))) AS t, "
            f"       LOWER(TRIM(COALESCE(unit_no::TEXT, ''))) AS u, "
            f"{area_col}"
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
            try:
                cur.execute(_build_sql(_CP_HAS_AREA), flat)
                cp_rows = cur.fetchall()
            except psycopg2.errors.UndefinedColumn:
                # CP_INVENTORY_TABLE has no `area_sqft` column. Degrade:
                # skip area on the SQL side from now on (area=None for all
                # candidates → _area_compatible returns True, behaving the
                # same as before the area-fallback feature).
                log.warning("CP table lacks area_sqft column — disabling area sanity check")
                _CP_HAS_AREA = False
                conn.rollback()
                cur.execute(_build_sql(False), flat)
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


CHUNK_SIZE = 500


def backfill_one_chunk(conn, cursor: str) -> dict:
    """Process ONE chunk (CHUNK_SIZE rows) of unscanned inventory rows by
    querying the CP DB directly via get_cp_conn(). Sized to fit inside the
    Vercel edge rewrite timeout (~30s) regardless of total table size.

    Per chunk: fetch the next CHUNK_SIZE unscanned classifiable rows from
    inventory, query CP once for the (society, bhk) keys in this chunk,
    classify each row in Python with _classify, bulk UPDATE inventory.

    Frontend loops, passing back `next_cursor` (max inventory.id from the
    previous chunk) until `done: true`. On the final chunk, a follow-up
    UPDATE settles leftover NULL rows (NULL society / bedrooms — unmatchable)
    to 'none'.

    To force a full rescan, run `UPDATE inventory SET cp_match = NULL` first.
    """
    if not config.CP_DB_URL:
        raise RuntimeError("CP_DB_URL is not set — cannot run scan")

    cursor_id = int(cursor) if cursor else 0

    perfect = partial = no_match = 0

    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, society, bedrooms, floor, tower, unit_no, area_sqft "
            "FROM inventory "
            "WHERE cp_match IS NULL "
            "  AND id > %s "
            "  AND society IS NOT NULL "
            "  AND TRIM(society) <> '' "
            "  AND bedrooms IS NOT NULL "
            "ORDER BY id LIMIT %s",
            (cursor_id, CHUNK_SIZE),
        )
        rows = cur.fetchall()

        if rows:
            keys = set()
            for r in rows:
                s = _norm(r.get("society"))
                b = _norm_bhk(r.get("bedrooms"))
                if s and b is not None:
                    keys.add((s, b))
            cp_index = _query_cp(keys)

            verdicts = []
            for r in rows:
                verdict = _classify(r, cp_index) or "none"
                verdicts.append((r["id"], verdict))
                if verdict == "perfect": perfect += 1
                elif verdict == "partial": partial += 1
                else: no_match += 1

            execute_values(
                cur,
                "UPDATE inventory AS i SET cp_match = v.verdict "
                "FROM (VALUES %s) AS v(id, verdict) "
                "WHERE i.id = v.id",
                verdicts, page_size=CHUNK_SIZE,
            )

        processed = len(rows)
        done = processed < CHUNK_SIZE
        next_cursor = str(rows[-1]["id"]) if rows else cursor

        if done:
            # Last chunk: settle leftover NULLs (NULL society / bedrooms —
            # unmatchable, so they land at 'none').
            cur.execute(
                "UPDATE inventory SET cp_match = 'none' WHERE cp_match IS NULL"
            )
            no_match += cur.rowcount
    conn.commit()

    log.info("cp_match chunk: cursor<=%s processed=%d perfect=%d partial=%d none=%d done=%s",
             next_cursor, processed, perfect, partial, no_match, done)

    return {
        "done": done,
        "next_cursor": next_cursor,
        "perfect": perfect,
        "partial": partial,
        "no_match": no_match,
        "processed": processed,
    }


# Fields whose change invalidates the persisted cp_match verdict.
MATCH_INPUT_FIELDS = {"society", "bedrooms", "floor", "tower", "unit_no"}
