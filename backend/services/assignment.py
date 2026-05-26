"""POC (point-of-contact) assignment for inventory rows.

POC is persisted on the inventory row (`assigned_rm_id` / `assigned_mgr_id`)
and is the sole driver of RM visibility (see `_scope_clause` in inventory.py).
Two paths populate it:

  - `resolve_assignment(cur, ...)`   — single new row at create / sync time.
  - `assign_missing_batch(conn, ...)` — periodic backfill for rows that came
                                        in without a match (e.g. before an RM
                                        had their society/micro set).

RM resolution rules — first match wins:
  1. Active rm whose `society[]` contains the lead's society
     (case/whitespace-insensitive — the data has 'ROF' / 'Rof' / 'rof' drift).
  2. Active rm whose `micro_market[]` overlaps with a micro that, per
     PROPERTIES_DB.master_societies, contains the lead's society.
  3. Active rm whose `cities[]` contains the lead's city ('Noida' expands to
     include 'Greater Noida' to match the city-tab convention).
  4. Otherwise — no RM (assigned_rm_id stays NULL).

Manager comes from the matched RM's `users.manager`. At create time only,
falls back to an active manager whose `cities[]` contains the row's city when
no RM matched / the matched RM has no manager.

When several users qualify, the lowest user id wins (stable, arbitrary).
"""
from __future__ import annotations

import logging
from typing import Tuple

from ..db import get_props_conn

log = logging.getLogger(__name__)


def _expand_cities(cities):
    """Mirror the city-tab convention: 'Noida' includes 'Greater Noida'."""
    expanded = set(cities or [])
    if "Noida" in expanded:
        expanded.add("Greater Noida")
    return expanded


def _resolve_rm_for_lead(
    cur, society: str | None, city: str | None = None,
) -> Tuple[int | None, int | None]:
    """Return (rm_id, mgr_id) for a single lead. Society > micro_market > city.
    Society matching is case/whitespace-insensitive.
    """
    s_norm = (society or "").strip().lower()

    # 1. Direct society overlap.
    if s_norm:
        cur.execute(
            """SELECT id, manager FROM users
               WHERE role = 'rm' AND is_active = TRUE
                 AND EXISTS (
                   SELECT 1 FROM unnest(society) AS s
                   WHERE LOWER(TRIM(s)) = %s
                 )
               ORDER BY id LIMIT 1""",
            (s_norm,),
        )
        row = cur.fetchone()
        if row:
            return (row["id"], row["manager"])

        # 2. Micro-market overlap, resolved via master_societies.
        try:
            pconn = get_props_conn()
            try:
                with pconn.cursor() as pcur:
                    pcur.execute(
                        """SELECT DISTINCT micro_market FROM master_societies
                           WHERE LOWER(TRIM(society_name)) = %s
                             AND micro_market IS NOT NULL""",
                        (s_norm,),
                    )
                    micros = [r["micro_market"] for r in pcur.fetchall()]
            finally:
                pconn.close()
        except Exception:
            log.exception("master_societies lookup failed for assignment")
            micros = []

        if micros:
            cur.execute(
                """SELECT id, manager FROM users
                   WHERE role = 'rm' AND is_active = TRUE
                     AND micro_market && %s
                   ORDER BY id LIMIT 1""",
                (micros,),
            )
            row = cur.fetchone()
            if row:
                return (row["id"], row["manager"])

    # 3. City overlap — broadest fallback. Property's city must be in some
    # active RM's cities[] (with 'Noida' expanded to include 'Greater Noida').
    if city:
        city_targets = list(_expand_cities([city]))
        cur.execute(
            """SELECT id, manager FROM users
               WHERE role = 'rm' AND is_active = TRUE
                 AND cities && %s
               ORDER BY id LIMIT 1""",
            (city_targets,),
        )
        row = cur.fetchone()
        if row:
            return (row["id"], row["manager"])

    return (None, None)


# Back-compat alias — old name still imported elsewhere.
_resolve_rm_for_society = _resolve_rm_for_lead


def resolve_assignment(cur, *, city: str, locality: str | None = None, society: str | None = None):
    """Return (rm_id, manager_id) for a single new inventory row.

    RM uses society → micro_market → cities (see `_resolve_rm_for_lead`).
    Manager comes from the matched RM's `manager`; falls back to an active
    manager whose `cities[]` contains `city` when no RM matched or the RM has
    no manager set.

    `locality` is accepted for call-site compatibility but ignored.
    """
    rm_id, mgr_id = _resolve_rm_for_lead(cur, society, city=city)

    if mgr_id is None and city:
        cur.execute(
            """SELECT id FROM users
               WHERE role = 'manager' AND is_active = TRUE
                 AND %s = ANY(cities)
               ORDER BY id LIMIT 1""",
            (city,),
        )
        row = cur.fetchone()
        if row:
            mgr_id = row["id"]

    return (rm_id, mgr_id)


def assign_missing_batch(
    conn,
    chunk_size: int = 2000,
    time_budget_s: float = 25.0,
) -> dict:
    """Backfill `assigned_rm_id` / `assigned_mgr_id` for rows where the RM is
    still NULL. Drains as much as fits within `time_budget_s` (kept under the
    Vercel edge ~30s).

    Each iteration scans `chunk_size` rows via an **id-cursor** —
    `WHERE id > cursor` advancing to `max(id)` of each chunk. That matters
    because unmatchable societies stay NULL: a `LIMIT N ORDER BY id` without
    a cursor keeps re-processing the same first N rows on every call and
    never reaches matchable rows at higher ids.

    Users mapping (society / micro_market → rm) is built once outside the
    loop; a resolved-society cache is reused across chunks. So per chunk
    we run at most one tiny master_societies query (only for societies not
    seen yet) plus one bulk UPDATE.

    Returns: {"updated": N, "scanned": N, "remaining": N}.
    """
    import time
    started_at = time.monotonic()

    # 1. Build user maps ONCE. Tiny table; reused across chunks.
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, manager, society, micro_market, cities FROM users
               WHERE role = 'rm' AND is_active = TRUE
               ORDER BY id"""
        )
        rms_data = cur.fetchall()

    soc_to_rm: dict[str, tuple[int, int | None]] = {}
    micro_to_rm: dict[str, tuple[int, int | None]] = {}
    city_to_rm: dict[str, tuple[int, int | None]] = {}
    for rm in rms_data:
        for s in (rm.get("society") or []):
            s_lc = (s or "").strip().lower()
            if s_lc and s_lc not in soc_to_rm:
                soc_to_rm[s_lc] = (rm["id"], rm.get("manager"))
        for m in (rm.get("micro_market") or []):
            if m and m not in micro_to_rm:
                micro_to_rm[m] = (rm["id"], rm.get("manager"))
        for c in _expand_cities(rm.get("cities") or []):
            if c and c not in city_to_rm:
                city_to_rm[c] = (rm["id"], rm.get("manager"))

    # society_lc -> (rm_id, mgr_id) | None (None = no society/micro match yet
    # — the city tier is still tried per-row below). Seeded with direct
    # society hits so we don't even query master_societies for them.
    resolved: dict[str, tuple[int, int | None] | None] = dict(soc_to_rm)

    cursor_id = 0
    total_updated = 0
    total_scanned = 0

    while True:
        if time.monotonic() - started_at > time_budget_s:
            log.info("assign_missing_batch: time budget hit at cursor=%d", cursor_id)
            break

        with conn.cursor() as cur:
            cur.execute(
                """SELECT id, society, city FROM inventory
                   WHERE assigned_rm_id IS NULL
                     AND ((society IS NOT NULL AND TRIM(society) <> '')
                          OR (city IS NOT NULL AND TRIM(city) <> ''))
                     AND id > %s
                   ORDER BY id
                   LIMIT %s""",
                (cursor_id, chunk_size),
            )
            rows = cur.fetchall()
            if not rows:
                break

            # Societies in this chunk we haven't resolved yet (cache miss).
            chunk_socs = {(r["society"] or "").strip().lower() for r in rows}
            chunk_socs.discard("")
            unknown = [s for s in chunk_socs if s not in resolved]

            if unknown:
                soc_micros: dict[str, list[str]] = {}
                try:
                    pconn = get_props_conn()
                    try:
                        with pconn.cursor() as pcur:
                            pcur.execute(
                                """SELECT LOWER(TRIM(society_name)) AS s_lc, micro_market
                                   FROM master_societies
                                   WHERE LOWER(TRIM(society_name)) = ANY(%s)
                                     AND micro_market IS NOT NULL""",
                                (unknown,),
                            )
                            for r in pcur.fetchall():
                                soc_micros.setdefault(r["s_lc"], []).append(r["micro_market"])
                    finally:
                        pconn.close()
                except Exception:
                    log.exception("master_societies lookup failed in assign_missing_batch")

                for s_lc in unknown:
                    match = None
                    for m in soc_micros.get(s_lc, []):
                        if m in micro_to_rm:
                            match = micro_to_rm[m]
                            break
                    resolved[s_lc] = match  # may be None — caches "no match"

            updates: list[tuple] = []
            for r in rows:
                s_lc = (r["society"] or "").strip().lower()
                match = resolved.get(s_lc) if s_lc else None
                if match is None:
                    # City fallback — broadest tier. 'Noida' rows match an RM
                    # scoped to either 'Noida' or 'Greater Noida' (and vv).
                    c = r.get("city")
                    if c:
                        match = city_to_rm.get(c)
                if match is not None:
                    rm_id, mgr_id = match
                    updates.append((r["id"], rm_id, mgr_id))

            if updates:
                from psycopg2.extras import execute_values
                execute_values(
                    cur,
                    """UPDATE inventory AS i SET
                           assigned_rm_id = v.rm_id,
                           assigned_mgr_id = COALESCE(v.mgr_id, i.assigned_mgr_id)
                       FROM (VALUES %s) AS v(id, rm_id, mgr_id)
                       WHERE i.id = v.id
                         AND i.assigned_rm_id IS NULL""",
                    updates,
                )

            total_scanned += len(rows)
            total_updated += len(updates)
            cursor_id = rows[-1]["id"]

        conn.commit()

    with conn.cursor() as cur:
        cur.execute(
            """SELECT COUNT(*) AS n FROM inventory
               WHERE assigned_rm_id IS NULL
                 AND ((society IS NOT NULL AND TRIM(society) <> '')
                      OR (city IS NOT NULL AND TRIM(city) <> ''))"""
        )
        remaining = cur.fetchone()["n"]

    elapsed = time.monotonic() - started_at
    log.info(
        "assign_missing_batch: scanned=%d updated=%d remaining=%d in %.2fs",
        total_scanned, total_updated, remaining, elapsed,
    )
    return {"updated": total_updated, "scanned": total_scanned, "remaining": remaining}
