"""Compute users.assigned_societies — the full set of societies a user's scope
covers: direct society picks ∪ every society in their micro-markets ∪ every
society in their cities (per PROPERTIES_DB.master_societies).

Stored on the app-DB users table so the "Clashed Societies" view (societies in
more than one RM's scope) is a cheap unnest+group. Cross-DB: reads
master_societies from the properties DB, writes users via the passed app-DB conn.
"""
from __future__ import annotations

import logging

from psycopg2.extras import execute_values

from ..db import get_props_conn

log = logging.getLogger(__name__)


def _expand_cities(cities):
    """Mirror the city-tab convention: 'Noida' includes 'Greater Noida'."""
    s = set(cities or [])
    if "Noida" in s:
        s.add("Greater Noida")
    return s


def _load_area_maps():
    """From master_societies build (micro_market -> {societies}) and
    (city -> {societies}) lookup maps."""
    micro_to: dict[str, set] = {}
    city_to: dict[str, set] = {}
    pconn = get_props_conn()
    try:
        with pconn, pconn.cursor() as pcur:
            pcur.execute(
                "SELECT society_name, micro_market, city FROM master_societies "
                "WHERE society_name IS NOT NULL AND society_name <> ''"
            )
            for r in pcur.fetchall():
                soc = (r["society_name"] or "").strip()
                if not soc:
                    continue
                if r.get("micro_market"):
                    micro_to.setdefault(r["micro_market"], set()).add(soc)
                if r.get("city"):
                    city_to.setdefault(r["city"], set()).add(soc)
    finally:
        pconn.close()
    return micro_to, city_to


def recompute_assigned_societies(conn, user_ids=None) -> int:
    """Recompute users.assigned_societies for `user_ids` (all users if None).
    Returns the number of users written. Commits on `conn`."""
    micro_to, city_to = _load_area_maps()
    with conn.cursor() as cur:
        if user_ids:
            cur.execute(
                "SELECT id, society, micro_market, cities FROM users WHERE id = ANY(%s)",
                (list(user_ids),),
            )
        else:
            cur.execute("SELECT id, society, micro_market, cities FROM users")
        users = cur.fetchall()

        rows = []
        for u in users:
            socs = {s.strip() for s in (u.get("society") or []) if s and s.strip()}
            for mm in (u.get("micro_market") or []):
                socs |= micro_to.get(mm, set())
            for c in _expand_cities(u.get("cities") or []):
                socs |= city_to.get(c, set())
            rows.append((u["id"], sorted(socs)))

        if rows:
            execute_values(
                cur,
                "UPDATE users AS u SET assigned_societies = v.socs "
                "FROM (VALUES %s) AS v(id, socs) WHERE u.id = v.id",
                rows, template="(%s, %s::text[])",
            )
    conn.commit()
    return len(rows)
