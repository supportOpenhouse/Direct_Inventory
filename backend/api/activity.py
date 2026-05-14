"""Read-only activity log endpoints.

Admin/manager only. Filters (all optional, AND-combined):
  q              — UID prefix/substring (matches activity_log.entity_id)
  action         — slug e.g. 'login', 'update', 'stage_change'
  entity_type    — 'auth' | 'inventory' | 'user' | 'sync' …
  actor_email    — exact match
  from / to      — ISO date inclusive (server time)
  sort, dir      — whitelisted sort

LEFT JOIN against users so we can show actor name alongside email.
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from .auth import require_auth

bp = Blueprint("activity", __name__, url_prefix="/api/activity")


SORTABLE = {
    "created_at":   "a.created_at",
    "entity_id":    "a.entity_id",
    "actor_email":  "a.actor_email",
    "action":       "a.action",
    "entity_type":  "a.entity_type",
}

HARD_LIMIT = 500   # the page caps here; FE shows a banner when total > limit


def _scope_clause(user: dict) -> tuple[str, list]:
    """Restrict managers to inventory activity in their cities. Admin sees all."""
    if user["role"] == "manager":
        return (
            " AND (a.entity_type <> 'inventory' OR a.entity_id IN ("
            "    SELECT oh_id FROM inventory WHERE city = ANY(%s)"
            " ))",
            [user.get("cities") or []],
        )
    return ("", [])


@bp.get("")
@require_auth("admin", "manager")
def list_activity():
    user = g.user
    args = request.args

    q = (args.get("q") or "").strip()
    action = (args.get("action") or "").strip()
    entity_type = (args.get("entity_type") or "").strip()
    actor_email = (args.get("actor_email") or "").strip()
    date_from = (args.get("from") or "").strip()
    date_to = (args.get("to") or "").strip()
    sort = (args.get("sort") or "created_at").strip()
    dir_ = "ASC" if (args.get("dir") or "").lower() == "asc" else "DESC"
    sort_sql = SORTABLE.get(sort, SORTABLE["created_at"])

    limit = min(args.get("limit", HARD_LIMIT, type=int), HARD_LIMIT)
    offset = args.get("offset", 0, type=int)

    where: list[str] = []
    params: list = []

    if q:
        where.append("a.entity_id ILIKE %s")
        params.append(f"%{q}%")
    if action:
        where.append("a.action = %s")
        params.append(action)
    if entity_type:
        where.append("a.entity_type = %s")
        params.append(entity_type)
    if actor_email:
        where.append("a.actor_email = %s")
        params.append(actor_email)
    if date_from:
        where.append("a.created_at >= %s")
        params.append(date_from)
    if date_to:
        where.append("a.created_at < (%s::date + INTERVAL '1 day')")
        params.append(date_to)

    scope_sql, scope_params = _scope_clause(user)
    # Always start with WHERE TRUE so the scope's " AND ..." chains cleanly.
    where_sql = "WHERE TRUE " + "".join(f"AND {c} " for c in where) + scope_sql

    base_from = (
        "FROM activity_log a "
        "LEFT JOIN users u ON u.email = a.actor_email "
        f"{where_sql}"
    )

    list_sql = (
        "SELECT a.id, a.created_at, a.actor_email, u.name AS actor_name, "
        "       a.entity_type, a.entity_id, a.action, a.field, "
        "       a.before_value, a.after_value, a.metadata "
        f"{base_from} "
        f"ORDER BY {sort_sql} {dir_}, a.id DESC "
        "LIMIT %s OFFSET %s"
    )
    count_sql = f"SELECT COUNT(*) AS n {base_from}"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(list_sql, [*params, *scope_params, limit, offset])
            rows = cur.fetchall()
            cur.execute(count_sql, [*params, *scope_params])
            total = cur.fetchone()["n"]
        return jsonify({"items": rows, "total": total, "limit": limit, "offset": offset})
    finally:
        conn.close()


@bp.get("/filters")
@require_auth("admin", "manager")
def filter_options():
    """Distinct values to populate the filter dropdowns on the page.

    Cheap enough to run on every page load — these tables are small.
    """
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT DISTINCT action FROM activity_log WHERE action IS NOT NULL ORDER BY action")
            actions = [r["action"] for r in cur.fetchall()]
            cur.execute("SELECT DISTINCT entity_type FROM activity_log WHERE entity_type IS NOT NULL ORDER BY entity_type")
            entity_types = [r["entity_type"] for r in cur.fetchall()]
            cur.execute(
                "SELECT DISTINCT a.actor_email AS email, u.name "
                "FROM activity_log a LEFT JOIN users u ON u.email = a.actor_email "
                "WHERE a.actor_email IS NOT NULL "
                "ORDER BY a.actor_email"
            )
            actors = cur.fetchall()
        return jsonify({"actions": actions, "entity_types": entity_types, "actors": actors})
    finally:
        conn.close()
