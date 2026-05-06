"""Read-only activity log endpoints. Admin sees all; manager sees own city; rm sees own."""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from .auth import require_auth

bp = Blueprint("activity", __name__, url_prefix="/api/activity")


@bp.get("")
@require_auth("admin", "manager")
def list_activity():
    user = g.user
    args = request.args
    entity_type = args.get("entity_type")
    entity_id = args.get("entity_id")
    actor_email = args.get("actor_email")
    limit = min(args.get("limit", 200, type=int), 1000)
    offset = args.get("offset", 0, type=int)

    sql = "SELECT * FROM activity_log WHERE TRUE"
    params: list = []

    if entity_type:
        sql += " AND entity_type = %s"
        params.append(entity_type)
    if entity_id:
        sql += " AND entity_id = %s"
        params.append(entity_id)
    if actor_email:
        sql += " AND actor_email = %s"
        params.append(actor_email)

    if user["role"] == "manager":
        # Restrict to inventory rows in their cities (best-effort join)
        sql += """ AND (entity_type <> 'inventory' OR entity_id IN (
                       SELECT oh_id FROM inventory WHERE city = ANY(%s)
                  ))"""
        params.append(user.get("cities") or [])

    sql += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
    params.extend([limit, offset])

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return jsonify({"items": rows, "limit": limit, "offset": offset})
    finally:
        conn.close()
