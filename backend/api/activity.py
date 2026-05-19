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

from datetime import datetime, timedelta, timezone

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from .auth import require_auth

IST = timezone(timedelta(hours=5, minutes=30))

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
    """Restrict managers to inventory activity in their cities. Admin sees all.

    City-list is expanded so 'Noida' includes 'Greater Noida' — matches the
    same convention used by inventory._scope_clause and the Noida city tab.
    """
    if user["role"] == "manager":
        cities = user.get("cities") or []
        if "Noida" in cities:
            cities = list(set(cities) | {"Greater Noida"})
        return (
            " AND (a.entity_type <> 'inventory' OR a.entity_id IN ("
            "    SELECT oh_id FROM inventory WHERE city = ANY(%s)"
            " ))",
            [cities],
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
        # `apps-script:*` is the grouping sentinel from the filters endpoint
        # — matches every per-batch sync entry as one logical "Apps Script"
        # actor instead of forcing the user to filter to a specific batch.
        if actor_email == "apps-script:*":
            where.append("a.actor_email LIKE 'apps-script:%%'")
        else:
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
            # Every Apps-Script batch posts under a distinct synthetic actor_email
            # (e.g. apps-script:direct-inventory:batch-5/77). Don't dump all of those
            # into the dropdown — collapse them into a single "Apps Script Sync"
            # entry whose value is the sentinel `apps-script:*`. The list endpoint
            # special-cases that value to a LIKE 'apps-script:%' filter.
            cur.execute(
                "SELECT DISTINCT a.actor_email AS email, u.name "
                "FROM activity_log a LEFT JOIN users u ON u.email = a.actor_email "
                "WHERE a.actor_email IS NOT NULL "
                "  AND a.actor_email NOT LIKE 'apps-script:%' "
                "ORDER BY a.actor_email"
            )
            actors = cur.fetchall()
            # Add the single grouped entry if any apps-script:* row exists.
            cur.execute(
                "SELECT 1 FROM activity_log WHERE actor_email LIKE 'apps-script:%' LIMIT 1"
            )
            if cur.fetchone():
                actors.append({"email": "apps-script:*", "name": "Apps Script Sync"})
        return jsonify({"actions": actions, "entity_types": entity_types, "actors": actors})
    finally:
        conn.close()


@bp.get("/daily-report")
@require_auth("admin")
def daily_report():
    """Per-user summary of inventory stage moves for one IST day.

    For each (actor, oh_id) touched on the selected day, keep only the LATEST
    stage_change — that's the stage the actor *left* the lead in. Apps-Script
    sync and the Forms webhook are excluded; they're not human actions.

    Query: ?date=YYYY-MM-DD (defaults to today IST).
    Response: { date, users: [{ actor_email, actor_name, total, counts, leads:[...] }] }
    """
    date_str = (request.args.get("date") or "").strip()
    if date_str:
        try:
            day_ist = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            return jsonify({"error": "invalid date; expected YYYY-MM-DD"}), 400
    else:
        day_ist = datetime.now(IST).date()

    # IST day window expressed as UTC bounds. activity_log.created_at is UTC,
    # so we compare against the same zone.
    start_ist = datetime(day_ist.year, day_ist.month, day_ist.day, tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    start_utc = start_ist.astimezone(timezone.utc)
    end_utc = end_ist.astimezone(timezone.utc)

    sql = """
        WITH latest_per_actor_lead AS (
            SELECT DISTINCT ON (a.actor_email, a.entity_id)
                a.actor_email,
                a.entity_id          AS oh_id,
                a.before_value       AS from_stage,
                a.after_value        AS final_stage,
                a.created_at         AS last_change_at
            FROM activity_log a
            WHERE a.action = 'stage_change'
              AND a.entity_type = 'inventory'
              AND a.created_at >= %s
              AND a.created_at <  %s
              AND a.actor_email IS NOT NULL
              AND a.actor_email NOT LIKE 'apps-script:%%'
              AND a.actor_email <> 'system:forms-webhook'
            ORDER BY a.actor_email, a.entity_id, a.created_at DESC
        )
        SELECT l.actor_email,
               u.name           AS actor_name,
               u.role           AS actor_role,
               l.oh_id,
               l.from_stage,
               l.final_stage,
               l.last_change_at,
               i.society,
               i.city,
               i.stage          AS current_stage,
               i.seller_name
        FROM latest_per_actor_lead l
        LEFT JOIN users     u ON u.email = l.actor_email
        LEFT JOIN inventory i ON i.oh_id = l.oh_id
        ORDER BY l.actor_email, l.last_change_at DESC
    """

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, (start_utc, end_utc))
            rows = cur.fetchall()
    finally:
        conn.close()

    # Group by actor in Python — simpler than two SQL passes and the result set
    # is bounded by stage_change volume per day (small).
    users: dict[str, dict] = {}
    for r in rows:
        key = r["actor_email"]
        bucket = users.get(key)
        if bucket is None:
            bucket = {
                "actor_email": key,
                "actor_name": r.get("actor_name"),
                "actor_role": r.get("actor_role"),
                "total": 0,
                "counts": {},
                "leads": [],
            }
            users[key] = bucket
        bucket["total"] += 1
        stage = r["final_stage"] or "(none)"
        bucket["counts"][stage] = bucket["counts"].get(stage, 0) + 1
        bucket["leads"].append({
            "oh_id": r["oh_id"],
            "society": r.get("society"),
            "city": r.get("city"),
            "from_stage": r.get("from_stage"),
            "final_stage": r.get("final_stage"),
            "current_stage": r.get("current_stage"),
            "seller_name": r.get("seller_name"),
            "last_change_at": r["last_change_at"],
        })

    # Sort users: most active first, then by display name / email.
    ordered = sorted(
        users.values(),
        key=lambda u: (-u["total"], (u["actor_name"] or u["actor_email"]).lower()),
    )

    return jsonify({"date": day_ist.isoformat(), "users": ordered})
