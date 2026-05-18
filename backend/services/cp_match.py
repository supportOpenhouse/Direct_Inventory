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
  - annotate_cp_match(rows) — Python-side classifier used by the list endpoint
    as a fallback for individual rows that haven't been scanned yet (e.g.
    just inserted, or invalidated by a recent PATCH). One CP-DB query per
    list page; cheap.
  - backfill_one_chunk(conn, cursor) / backfill_all_fdw(conn) — admin-
    triggered full scan. Runs as a single SQL pipeline via postgres_fdw
    (see migration 012_cp_fdw.sql): one materialized read of the CP
    `submissions` foreign table, a join against unscanned inventory rows,
    aggregated verdict per row, one UPDATE. No chunking, no Python loop.
    backfill_one_chunk wraps backfill_all_fdw to keep the existing
    cursor-based endpoint API stable for the frontend.
"""
from __future__ import annotations

import logging

import psycopg2
from psycopg2.extras import execute_values

from .. import config
from ..db import get_cp_conn

log = logging.getLogger(__name__)

BATCH_SIZE = 200

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


_SCAN_SQL = """
WITH cp_snapshot AS MATERIALIZED (
    -- Pull CP rows across the FDW wire ONCE, into a local materialization
    -- the planner will reuse. Filter out rows that can't match anyway.
    SELECT
        LOWER(TRIM(society_name)) AS s,
        SUBSTRING(bhk FROM '^[0-9]+') AS b,
        LOWER(TRIM(COALESCE(floor, ''))) AS f,
        LOWER(TRIM(COALESCE(tower, ''))) AS t,
        LOWER(TRIM(COALESCE(unit_no, ''))) AS u,
        sqft::NUMERIC AS a,
        (
            LOWER(TRIM(COALESCE(floor, ''))) = 'top'
            OR (
                LOWER(TRIM(COALESCE(floor, ''))) ~ '^[0-9]+$'
                AND LOWER(TRIM(COALESCE(floor, '')))::INT BETWEEN 1 AND 50
            )
        ) AS f_ok
    FROM cp_submissions
    WHERE society_name IS NOT NULL
      AND SUBSTRING(bhk FROM '^[0-9]+') IS NOT NULL
),
direct_rows AS (
    -- Unscanned, classifiable Direct rows. NULL society/bedrooms can't match.
    SELECT
        id,
        LOWER(TRIM(society)) AS s,
        bedrooms::TEXT AS b,
        LOWER(TRIM(COALESCE(floor, ''))) AS f,
        LOWER(TRIM(COALESCE(tower, ''))) AS t,
        LOWER(TRIM(COALESCE(unit_no, ''))) AS u,
        area_sqft AS a,
        (
            LOWER(TRIM(COALESCE(floor, ''))) = 'top'
            OR (
                LOWER(TRIM(COALESCE(floor, ''))) ~ '^[0-9]+$'
                AND LOWER(TRIM(COALESCE(floor, '')))::INT BETWEEN 1 AND 50
            )
        ) AS f_ok
    FROM inventory
    WHERE cp_match IS NULL
      AND society IS NOT NULL
      AND TRIM(society) <> ''
      AND bedrooms IS NOT NULL
),
pairs AS (
    -- Cross join is gated on society+bhk so the candidate set per Direct
    -- row is small. floor_ok and tu_perfect mirror _unit_compatible /
    -- the perfect-match check in the Python implementation.
    SELECT
        d.id,
        CASE
            WHEN d.f_ok AND c.f_ok THEN (d.f = c.f)
            ELSE (d.a IS NULL OR c.a IS NULL OR ABS(d.a - c.a) <= 25)
        END AS floor_ok,
        (d.t <> '' AND d.u <> '' AND d.t = c.t AND d.u = c.u) AS tu_perfect
    FROM direct_rows d
    INNER JOIN cp_snapshot c ON c.s = d.s AND c.b = d.b
),
verdicts AS (
    SELECT
        id,
        CASE
            WHEN BOOL_OR(floor_ok AND tu_perfect) THEN 'perfect'
            WHEN BOOL_OR(floor_ok) THEN 'partial'
            ELSE 'none'
        END AS verdict
    FROM pairs
    GROUP BY id
),
updated AS (
    -- Update each scanned Direct row. Rows in direct_rows with no candidate
    -- (no society+bhk match) come through via the LEFT JOIN with verdict=NULL
    -- → COALESCE pins them to 'none'.
    UPDATE inventory i
    SET cp_match = COALESCE(v.verdict, 'none')
    FROM direct_rows d
    LEFT JOIN verdicts v ON v.id = d.id
    WHERE i.id = d.id
    RETURNING i.cp_match
)
SELECT cp_match, count(*) AS cnt FROM updated GROUP BY cp_match;
"""


def backfill_all_fdw(conn) -> dict:
    """Run the full cp_match scan as one SQL pipeline via postgres_fdw.

    Requires migration 012_cp_fdw.sql to have been applied — that creates
    the foreign table `cp_submissions` pointing at the CP DB. With that in
    place the entire scan is a single SQL statement: pull CP across the
    wire once (materialized), join with unscanned inventory rows on
    (society, bhk), aggregate verdicts, UPDATE inventory. No Python loop,
    no chunking, no per-chunk CP round-trip.

    Rows where Direct's society or bedrooms is NULL are handled separately
    by a follow-up UPDATE — they can never match by definition, so they
    land at 'none'.

    Returns counts: { perfect, partial, no_match, processed }.
    """
    perfect = partial = none = 0
    with conn.cursor() as cur:
        cur.execute(_SCAN_SQL)
        for row in cur.fetchall():
            v, cnt = row["cp_match"], row["cnt"]
            if v == "perfect": perfect = cnt
            elif v == "partial": partial = cnt
            elif v == "none": none = cnt

        # Direct rows that the CTE excluded (NULL society / bedrooms) are
        # still cp_match=NULL. Settle them to 'none' so the column is no
        # longer "unscanned" and they don't reappear next click.
        cur.execute(
            "UPDATE inventory SET cp_match = 'none' WHERE cp_match IS NULL"
        )
        none += cur.rowcount
    conn.commit()

    processed = perfect + partial + none
    log.info("cp_match FDW scan: processed=%d perfect=%d partial=%d none=%d",
             processed, perfect, partial, none)
    return {"perfect": perfect, "partial": partial, "no_match": none, "processed": processed}


def backfill_one_chunk(conn, cursor: str) -> dict:
    """Single-shot cp_match scan via postgres_fdw, packaged to keep the
    chunked-endpoint API stable.

    First call (cursor=='') does the FDW-driven cp_match scan + 'none' settle
    and returns done=true with full totals. Subsequent calls return done=true
    with zero totals — kept for API compatibility with the frontend loop,
    which still terminates correctly.

    oh_id assignment is handled at insert time (manual create + sheet sync).
    Legacy rows missing oh_id should be backfilled once via
    `python -m backend.scripts.backfill_oh_ids`.

    To force a full rescan, run `UPDATE inventory SET cp_match = NULL` first.
    Raises if CP_DB_URL is unset (CP DB unreachable would surface as a
    Postgres error from the FDW query, which propagates up).
    """
    if not config.CP_DB_URL:
        raise RuntimeError("CP_DB_URL is not set — cannot run scan")

    if cursor != "":
        return {"done": True, "next_cursor": cursor,
                "perfect": 0, "partial": 0, "no_match": 0, "processed": 0}

    result = backfill_all_fdw(conn)
    return {
        "done": True,
        "next_cursor": "",
        "perfect": result["perfect"],
        "partial": result["partial"],
        "no_match": result["no_match"],
        "processed": result["processed"],
    }


# Fields whose change invalidates the persisted cp_match verdict.
MATCH_INPUT_FIELDS = {"society", "bedrooms", "floor", "tower", "unit_no"}
