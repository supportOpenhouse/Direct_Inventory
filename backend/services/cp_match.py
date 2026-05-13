"""CP Inventory match annotation.

For a batch of Direct Inventory rows, look up matches in the CP Inventory
Portal DB and annotate each row with `cp_match`:

  'perfect' — society + bhk + floor + tower + unit_no all match
  'partial' — society + bhk + floor match (but not tower+unit_no)
  None      — no match found, or CP DB not configured / unreachable.

CP DB connection is read-only; failure to reach it is non-fatal — the list
endpoint should keep working even if CP is down.
"""
from __future__ import annotations

import logging

from .. import config
from ..db import get_cp_conn

log = logging.getLogger(__name__)


def _norm(v) -> str:
    return (str(v).strip().lower() if v not in (None, "") else "")


def annotate_cp_match(rows: list[dict]) -> None:
    """Mutate each row in-place, adding a `cp_match` field."""
    for r in rows:
        r["cp_match"] = None

    if not config.CP_DB_URL or not rows:
        return

    # Build the keyset we need to ask CP about. Skip rows missing the
    # bare-minimum partial-match fields — they can't match by definition.
    keys = set()
    for r in rows:
        s = _norm(r.get("society"))
        b = r.get("bedrooms")
        f = _norm(r.get("floor"))
        if s and b is not None:
            keys.add((s, b, f))

    if not keys:
        return

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
            return
        with conn, conn.cursor() as cur:
            cur.execute(sql, flat)
            cp_rows = cur.fetchall()
    except Exception:
        log.exception("CP match lookup failed — falling back to no annotation")
        return
    finally:
        if conn is not None:
            try: conn.close()
            except Exception: pass

    # Index: (s,b,f) -> set of (t,u) tuples in CP
    index: dict[tuple, set] = {}
    for cp in cp_rows:
        key = (cp["s"], cp["b"], cp["f"])
        index.setdefault(key, set()).add((cp["t"], cp["u"]))

    for r in rows:
        s = _norm(r.get("society"))
        b = r.get("bedrooms")
        f = _norm(r.get("floor"))
        if not s or b is None:
            continue
        key = (s, b, f)
        cp_set = index.get(key)
        if not cp_set:
            continue
        t = _norm(r.get("tower"))
        u = _norm(r.get("unit_no"))
        if t and u and (t, u) in cp_set:
            r["cp_match"] = "perfect"
        else:
            r["cp_match"] = "partial"
