"""User management. Admin-only writes; managers/admins can list."""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request

from ..db import get_conn, get_props_conn
from ..services.activity import log as log_activity
from .auth import require_auth

bp = Blueprint("users", __name__, url_prefix="/api/users")

VALID_ROLES = {"admin", "manager", "rm"}


@bp.get("/profile")
@require_auth()
def my_profile():
    """The signed-in user's own profile: identity + scope + manager + team.

    `team` = users who report to me (manager = my id) — relevant for admin and
    manager. `manager` = the user my `manager` column points at (managers/rm).
    Any authenticated role may read their own profile. Admins may pass
    `?user_id=<id>` to view another user's profile (the "view as" POV).
    """
    uid = g.user["id"]
    req_uid = request.args.get("user_id", type=int)
    if req_uid and req_uid != uid:
        if g.user["role"] != "admin":
            return jsonify({"error": "forbidden"}), 403
        uid = req_uid
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT u.id, u.email, u.name, u.phone, u.role, u.cities, u.society, "
                "       u.micro_market, u.is_active, "
                "       m.id AS manager_id, m.name AS manager_name, m.email AS manager_email "
                "FROM users u LEFT JOIN users m ON m.id = u.manager "
                "WHERE u.id = %s",
                (uid,),
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "user not found"}), 404
            cur.execute(
                "SELECT id, name, email, role, is_active FROM users "
                "WHERE manager = %s ORDER BY role, name, email",
                (uid,),
            )
            team = cur.fetchall()
        manager = None
        if row.get("manager_id"):
            manager = {"id": row["manager_id"], "name": row["manager_name"], "email": row["manager_email"]}
        return jsonify({
            "id": row["id"], "email": row["email"], "name": row["name"],
            "phone": row["phone"], "role": row["role"],
            "cities": row["cities"] or [], "society": row["society"] or [],
            "micro_market": row["micro_market"] or [],
            "manager": manager, "team": team,
        })
    finally:
        conn.close()


@bp.get("")
@require_auth("admin", "manager")
def list_users():
    role = request.args.get("role")
    city = request.args.get("city")

    sql = """
        SELECT u.id, u.email, u.name, u.phone, u.role,
               u.cities, u.society, u.micro_market, u.manager,
               u.is_active, u.created_at,
               m.name AS manager_name, m.email AS manager_email
        FROM users u
        LEFT JOIN users m ON m.id = u.manager
        WHERE TRUE
    """
    params: list = []
    if role:
        sql += " AND u.role = %s"
        params.append(role)
    if city:
        sql += " AND %s = ANY(u.cities)"
        params.append(city)
    sql += " ORDER BY u.role, u.email"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return jsonify({"items": rows})
    finally:
        conn.close()


@bp.get("/master-areas")
@require_auth("admin")
def master_areas():
    """Distinct cities / micro-markets / societies from the read-only
    PROPERTIES_DB.master_societies table. Populates the scope pickers on the
    user edit modal.
    """
    conn = get_props_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT city FROM master_societies "
                "WHERE city IS NOT NULL AND city <> '' ORDER BY city"
            )
            cities = [r["city"] for r in cur.fetchall()]
            cur.execute(
                "SELECT DISTINCT micro_market FROM master_societies "
                "WHERE micro_market IS NOT NULL AND micro_market <> '' ORDER BY micro_market"
            )
            micro_markets = [r["micro_market"] for r in cur.fetchall()]
            cur.execute(
                "SELECT DISTINCT society_name FROM master_societies "
                "WHERE society_name IS NOT NULL AND society_name <> '' ORDER BY society_name"
            )
            societies = [r["society_name"] for r in cur.fetchall()]
        return jsonify({
            "cities": cities,
            "micro_markets": micro_markets,
            "societies": societies,
        })
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
    allowed = {"name", "phone", "role", "cities", "is_active",
               "society", "micro_market", "manager"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if "role" in updates and updates["role"] not in VALID_ROLES:
        return jsonify({"error": "invalid role"}), 400
    # manager: coerce to int or NULL; a user can't be their own manager.
    if "manager" in updates:
        mv = updates["manager"]
        updates["manager"] = int(mv) if mv not in (None, "", 0) else None
        if updates["manager"] == user_id:
            return jsonify({"error": "a user cannot be their own manager"}), 400
    # Array scope fields — normalise null -> empty array.
    for arr_field in ("cities", "society", "micro_market"):
        if arr_field in updates and updates[arr_field] is None:
            updates[arr_field] = []
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
