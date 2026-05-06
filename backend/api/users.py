"""User management. Admin-only writes; managers/admins can list."""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from ..services.activity import log as log_activity
from .auth import require_auth

bp = Blueprint("users", __name__, url_prefix="/api/users")

VALID_ROLES = {"admin", "manager", "rm"}


@bp.get("")
@require_auth("admin", "manager")
def list_users():
    role = request.args.get("role")
    city = request.args.get("city")

    sql = "SELECT id, email, name, phone, role, cities, is_active, created_at FROM users WHERE TRUE"
    params: list = []
    if role:
        sql += " AND role = %s"
        params.append(role)
    if city:
        sql += " AND %s = ANY(cities)"
        params.append(city)
    sql += " ORDER BY role, email"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return jsonify({"items": rows})
    finally:
        conn.close()


@bp.post("")
@require_auth("admin")
def create_user():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    role = body.get("role")
    name = body.get("name")
    phone = body.get("phone")
    cities = body.get("cities") or []

    if not email or role not in VALID_ROLES:
        return jsonify({"error": "email and valid role required"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO users (email, name, phone, role, cities, is_active)
                   VALUES (%s, %s, %s, %s, %s, TRUE)
                   ON CONFLICT (email) DO UPDATE
                     SET role = EXCLUDED.role,
                         name = COALESCE(EXCLUDED.name, users.name),
                         phone = COALESCE(EXCLUDED.phone, users.phone),
                         cities = EXCLUDED.cities,
                         is_active = TRUE
                   RETURNING *""",
                (email, name, phone, role, cities),
            )
            row = cur.fetchone()
            log_activity(
                cur, actor_user_id=g.user["id"], actor_email=g.user["email"],
                entity_type="user", entity_id=str(row["id"]), action="upsert",
                metadata={"email": email, "role": role, "cities": cities},
            )
        return jsonify(row), 201
    finally:
        conn.close()


@bp.patch("/<int:user_id>")
@require_auth("admin")
def update_user(user_id: int):
    body = request.get_json(silent=True) or {}
    allowed = {"name", "phone", "role", "cities", "is_active"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if "role" in updates and updates["role"] not in VALID_ROLES:
        return jsonify({"error": f"invalid role"}), 400
    if not updates:
        return jsonify({"error": "no editable fields"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE id = %s FOR UPDATE", (user_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "not found"}), 404
            for k, v in updates.items():
                log_activity(
                    cur, actor_user_id=g.user["id"], actor_email=g.user["email"],
                    entity_type="user", entity_id=str(user_id), action="update",
                    field=k, before_value=existing.get(k), after_value=v,
                )
            cols = ", ".join(f"{k} = %s" for k in updates.keys())
            cur.execute(f"UPDATE users SET {cols} WHERE id = %s RETURNING *",
                        (*updates.values(), user_id))
            row = cur.fetchone()
        return jsonify(row)
    finally:
        conn.close()
