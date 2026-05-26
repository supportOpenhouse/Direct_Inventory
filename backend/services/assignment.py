"""POC (point-of-contact) assignment for inventory rows.

POC is persisted on the inventory row (`assigned_rm_id` / `assigned_mgr_id`)
and is the sole driver of RM visibility (see `_scope_clause` in inventory.py).
Two paths populate it:

  - `resolve_assignment(cur, ...)`   — single new row at create / sync time.
  - `assign_missing_batch(conn, ...)` — periodic backfill for rows that came
                                        in without a match (e.g. before an RM
                                        had their society/micro set).

RM resolution rules (society → micro_market; **no cities fallback**):
  1. Active rm whose `society[]` contains the lead's society
     (case/whitespace-insensitive — the data has 'ROF' / 'Rof' / 'rof' drift).
  2. Active rm whose `micro_market[]` overlaps with a micro that, per
     PROPERTIES_DB.master_societies, contains the lead's society.
  3. Otherwise — no RM (assigned_rm_id stays NULL).

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


def _resolve_rm_for_society(cur, society: str | None) -> Tuple[int | None, int | None]:
    """Return (rm_id, mgr_id) for one society. Case/whitespace-insensitive."""
    if not society:
        return (None, None)
    s_norm = society.strip().lower()

    # 1. Direct society overlap.
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
        return (None, None)

    if not micros:
        return (None, None)

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

    return (None, None)


def resolve_assignment(cur, *, city: str, locality: str | None = None, society: str | None = None):
    """Return (rm_id, manager_id) for a single new inventory row.

    RM uses society → micro_market (see `_resolve_rm_for_society`). Manager
    comes from the matched RM's `manager`; falls back to an active manager
    whose `cities[]` contains `city` when no RM matched or the RM has no
    manager set.

    `locality` is accepted for call-site compatibility but ignored.
    """
    rm_id, mgr_id = _resolve_rm_for_society(cur, society)

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


def assign_missing_batch(conn, limit: int = 2000) -> dict:
    """Backfill `assigned_rm_id` / `assigned_mgr_id` for rows where the RM is
    still NULL. Same society → micro_market logic as `resolve_assignment`,
    but batched: all distinct societies in the chunk are resolved together in
    two queries (users + master_societies), then one bulk UPDATE.

    Returns: {"updated": N, "scanned": N, "remaining": N}.

    Cheap in steady state (zero NULL rows → returns immediately) and bounded
    per call by `limit` so it stays well under any proxy timeout, even on the
    initial bulk backfill of legacy rows.
    """
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, society FROM inventory
               WHERE assigned_rm_id IS NULL
                 AND society IS NOT NULL AND TRIM(society) <> ''
               ORDER BY id
               LIMIT %s""",
            (limit,),
        )
        rows = cur.fetchall()
        scanned = len(rows)
        if not rows:
            cur.execute(
                """SELECT COUNT(*) AS n FROM inventory
                   WHERE assigned_rm_id IS NULL
                     AND society IS NOT NULL AND TRIM(society) <> ''"""
            )
            return {"updated": 0, "scanned": 0, "remaining": cur.fetchone()["n"]}

        socs_lc = list({(r["society"] or "").strip().lower() for r in rows})

        # 1. society_lc → (rm_id, mgr_id) from users.society[].
        cur.execute(
            """SELECT id, manager, society FROM users
               WHERE role = 'rm' AND is_active = TRUE
               ORDER BY id"""
        )
        soc_to_rm: dict[str, tuple[int, int | None]] = {}
        for rm in cur.fetchall():
            for s in (rm.get("society") or []):
                s_lc = (s or "").strip().lower()
                if s_lc and s_lc not in soc_to_rm:
                    soc_to_rm[s_lc] = (rm["id"], rm.get("manager"))

        # 2. For societies that didn't match directly, resolve via micro_market.
        unmatched = [s for s in socs_lc if s not in soc_to_rm]
        if unmatched:
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
                            (unmatched,),
                        )
                        for r in pcur.fetchall():
                            soc_micros.setdefault(r["s_lc"], []).append(r["micro_market"])
                finally:
                    pconn.close()
            except Exception:
                log.exception("master_societies lookup failed in assign_missing_batch")

            if soc_micros:
                cur.execute(
                    """SELECT id, manager, micro_market FROM users
                       WHERE role = 'rm' AND is_active = TRUE
                       ORDER BY id"""
                )
                micro_to_rm: dict[str, tuple[int, int | None]] = {}
                for rm in cur.fetchall():
                    for m in (rm.get("micro_market") or []):
                        if m and m not in micro_to_rm:
                            micro_to_rm[m] = (rm["id"], rm.get("manager"))

                for s_lc, micros in soc_micros.items():
                    for m in micros:
                        if m in micro_to_rm:
                            soc_to_rm[s_lc] = micro_to_rm[m]
                            break

        # 3. Build updates: skip rows with no RM match — they stay NULL so the
        # next scan retries (cheap), and they correctly count as "no POC".
        updates: list[tuple] = []
        for r in rows:
            s_lc = (r["society"] or "").strip().lower()
            match = soc_to_rm.get(s_lc)
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

        cur.execute(
            """SELECT COUNT(*) AS n FROM inventory
               WHERE assigned_rm_id IS NULL
                 AND society IS NOT NULL AND TRIM(society) <> ''"""
        )
        remaining = cur.fetchone()["n"]

    conn.commit()
    log.info(
        "assign_missing_batch: scanned=%d updated=%d remaining=%d",
        scanned, len(updates), remaining,
    )
    return {"updated": len(updates), "scanned": scanned, "remaining": remaining}
