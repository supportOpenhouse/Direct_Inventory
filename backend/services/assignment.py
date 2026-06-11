"""POC (point-of-contact) assignment for inventory rows.

POC is persisted on the inventory row (`assigned_rm_ids` / `assigned_mgr_id`)
and is the sole driver of RM visibility (see `_scope_clause` in
api/inventory/_common.py). Two paths populate it:

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
  4. Otherwise — no RM (assigned_rm_ids stays empty).

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

# Placeholder RM that unmatched leads fall back to (created by migration 026).
# Looked up by this stable email; if the row is absent (migration not yet run)
# the fallback is skipped and leads stay unassigned as before.
UNALLOCATED_EMAIL = "unallocated@openhouse.in"


def _unallocated_id(cur) -> int | None:
    cur.execute("SELECT id FROM users WHERE LOWER(email) = %s", (UNALLOCATED_EMAIL,))
    row = cur.fetchone()
    return row["id"] if row else None


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

    # No real RM matched → fall back to the 'Unallocated' placeholder RM.
    if rm_id is None:
        rm_id = _unallocated_id(cur)

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
    mode: str = "missing",
) -> dict:
    """Backfill `assigned_rm_ids` / `assigned_mgr_id` on inventory.

    mode:
      'missing' (default) — only touch rows whose assigned_rm_ids is still
                            empty. Cheap in steady state.
      'all'              — re-evaluate every row and overwrite the assignment
                            when the society/micro/city scope now matches an
                            RM. Rows with no match are left untouched.

    Drains as much as fits within `time_budget_s` (kept under the Vercel edge
    ~30s).

    Each iteration scans `chunk_size` rows via an **id-cursor** —
    `WHERE id > cursor` advancing to `max(id)` of each chunk. That matters
    because unmatchable societies stay empty: a `LIMIT N ORDER BY id` without
    a cursor keeps re-processing the same first N rows on every call and
    never reaches matchable rows at higher ids.

    For each property, this collects EVERY active RM whose society / micro-
    market / city scope covers it — so a lead that matches one RM via society
    and another via micro-market ends up assigned to both. Society matching
    is case/whitespace-insensitive. Cities are expanded so 'Noida' matches
    'Greater Noida' rows too.

    Returns: {"updated": N, "scanned": N, "remaining": N}.
    """
    import time
    started_at = time.monotonic()

    # 1. Snapshot every active RM's scope, pre-built into fast lookup sets so
    # per-row matching is O(rms) of cheap set membership checks.
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, manager, society, micro_market, cities FROM users
               WHERE role = 'rm' AND is_active = TRUE
               ORDER BY id"""
        )
        rms_data = cur.fetchall()
        unallocated_id = _unallocated_id(cur)

    # The Unallocated placeholder must never auto-match by scope — it's only the
    # explicit fallback below — so drop it from the matchable set.
    rm_scope = [{
        "id":      rm["id"],
        "manager": rm.get("manager"),
        "soc_lc":  {(s or "").strip().lower() for s in (rm.get("society") or []) if s},
        "micro":   set(rm.get("micro_market") or []),
        "cities":  set(_expand_cities(rm.get("cities") or [])),
    } for rm in rms_data if rm["id"] != unallocated_id]

    # society_lc -> set of micro_markets that contain it (per master_societies).
    # Filled lazily per chunk; entries persist across chunks.
    soc_to_micros: dict[str, set] = {}

    cursor_id = 0
    total_updated = 0
    total_scanned = 0

    while True:
        if time.monotonic() - started_at > time_budget_s:
            log.info("assign_missing_batch: time budget hit at cursor=%d", cursor_id)
            break

        unassigned_clause = "" if mode == "all" else "AND cardinality(assigned_rm_ids) = 0"
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT id, society, city FROM inventory
                    WHERE ((society IS NOT NULL AND TRIM(society) <> '')
                           OR (city IS NOT NULL AND TRIM(city) <> ''))
                      {unassigned_clause}
                      AND id > %s
                    ORDER BY id
                    LIMIT %s""",
                (cursor_id, chunk_size),
            )
            rows = cur.fetchall()
            if not rows:
                break

            # 2. master_societies lookup for any society we haven't resolved yet.
            chunk_socs = {(r["society"] or "").strip().lower() for r in rows}
            chunk_socs.discard("")
            unknown = [s for s in chunk_socs if s not in soc_to_micros]
            if unknown:
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
                                soc_to_micros.setdefault(r["s_lc"], set()).add(r["micro_market"])
                    finally:
                        pconn.close()
                except Exception:
                    log.exception("master_societies lookup failed in assign_missing_batch")
                # Mark unknowns we didn't resolve so we don't re-query them.
                for s_lc in unknown:
                    soc_to_micros.setdefault(s_lc, set())

            # 3. For each property, find EVERY matching RM and collect ids.
            updates: list[tuple] = []
            for r in rows:
                p_soc_lc = (r["society"] or "").strip().lower()
                p_city = r.get("city")
                p_micros = soc_to_micros.get(p_soc_lc, set())

                matched_ids: list[int] = []
                matched_mgr: int | None = None
                for rm in rm_scope:
                    hit = (
                        (p_soc_lc and p_soc_lc in rm["soc_lc"])
                        or (p_micros and bool(rm["micro"] & p_micros))
                        or (p_city  and p_city in rm["cities"])
                    )
                    if hit:
                        matched_ids.append(rm["id"])
                        if matched_mgr is None:
                            matched_mgr = rm["manager"]

                # No real RM matched → fall back to the 'Unallocated' placeholder
                # so the lead still gets a POC instead of staying unassigned.
                if not matched_ids and unallocated_id is not None:
                    matched_ids = [unallocated_id]
                    matched_mgr = None

                if matched_ids:
                    updates.append((r["id"], matched_ids, matched_mgr))

            if updates:
                from psycopg2.extras import execute_values
                update_guard = "" if mode == "all" else "AND cardinality(i.assigned_rm_ids) = 0"
                execute_values(
                    cur,
                    f"""UPDATE inventory AS i SET
                           assigned_rm_ids = v.rm_ids,
                           assigned_mgr_id = COALESCE(v.mgr_id, i.assigned_mgr_id)
                       FROM (VALUES %s) AS v(id, rm_ids, mgr_id)
                       WHERE i.id = v.id
                         {update_guard}""",
                    updates,
                    # Type every column: when an entire batch falls back to the
                    # Unallocated placeholder, mgr_id is all-NULL and Postgres
                    # would otherwise infer it as text, breaking the COALESCE
                    # against the integer assigned_mgr_id column.
                    template="(%s::INT, %s::INT[], %s::INT)",
                )

            total_scanned += len(rows)
            total_updated += len(updates)
            cursor_id = rows[-1]["id"]

        conn.commit()

    with conn.cursor() as cur:
        cur.execute(
            """SELECT COUNT(*) AS n FROM inventory
               WHERE cardinality(assigned_rm_ids) = 0
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
