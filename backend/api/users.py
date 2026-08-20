"""User management. Admin-only writes; managers/admins can list."""
from __future__ import annotations

import logging

from flask import Blueprint, g, jsonify, request

from ..db import get_conn, get_props_conn
from ..services.activity import log as log_activity
from ..services.society_scope import recompute_assigned_societies
from .auth import require_auth

log = logging.getLogger(__name__)

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
                "       COALESCE(u.manager_ids, '{}'::int[]) AS manager_ids "
                "FROM users u WHERE u.id = %s",
                (uid,),
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "user not found"}), 404
            # An RM can report to several managers now — resolve them all.
            managers = []
            if row["manager_ids"]:
                cur.execute(
                    "SELECT id, name, email FROM users WHERE id = ANY(%s) ORDER BY name, email",
                    (row["manager_ids"],),
                )
                managers = cur.fetchall()
            cur.execute(
                "SELECT id, name, email, role, is_active FROM users "
                "WHERE %s = ANY(manager_ids) ORDER BY role, name, email",
                (uid,),
            )
            team = cur.fetchall()
        return jsonify({
            "id": row["id"], "email": row["email"], "name": row["name"],
            "phone": row["phone"], "role": row["role"],
            "cities": row["cities"] or [], "society": row["society"] or [],
            "micro_market": row["micro_market"] or [],
            "manager_ids": row["manager_ids"], "managers": managers, "team": team,
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
               u.cities, u.society, u.micro_market,
               COALESCE(u.manager_ids, '{}'::int[]) AS manager_ids,
               u.is_active, u.created_at,
               (SELECT string_agg(m.name, ', ' ORDER BY m.name)
                  FROM users m WHERE m.id = ANY(u.manager_ids)) AS manager_names
        FROM users u
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
        resp = jsonify({
            "cities": cities,
            "micro_markets": micro_markets,
            "societies": societies,
        })
        # Master areas change rarely; let the browser skip refetches for 10 min.
        resp.headers["Cache-Control"] = "private, max-age=600"
        return resp
    finally:
        conn.close()


# ── multi-manager helpers ────────────────────────────────────────────────────
# An RM can report to several managers: users.manager_ids is an INT[]. The array has
# no per-element FK, so the app validates the ids here (migration 043).

def _coerce_manager_ids(body, role):
    """(mids:list|None, error:str|None). Reads `manager_ids` (list) or the legacy single
    `manager` key. Only meaningful for RMs. Not provided → (None, None) (leave unchanged);
    empty → ([]) which the caller stores as NULL."""
    if role != "rm":
        return None, None
    if "manager_ids" in body:
        raw = body.get("manager_ids") or []
    elif "manager" in body:  # legacy single-value alias — normalise to a one-element list
        legacy = body.get("manager")
        raw = [] if legacy in (None, "", 0, "0") else [legacy]
    else:
        return None, None
    if not isinstance(raw, list):
        return None, "manager_ids must be a list of integers or null"
    mids = []
    for mid in raw:
        try:
            mid = int(mid)
        except (TypeError, ValueError):
            return None, "manager_ids must be a list of integers"
        if mid not in mids:  # dedupe, preserve order
            mids.append(mid)
    return mids, None


def _validate_managers_exist(cur, mids):
    """None if every id is an active manager, else an error string. One round-trip."""
    if not mids:
        return None
    cur.execute("SELECT id FROM users WHERE id = ANY(%s) AND role = 'manager' AND is_active",
                (mids,))
    found = {r["id"] for r in cur.fetchall()}
    bad = [m for m in mids if m not in found]
    if bad:
        return "not a manager (or not found): " + ", ".join(str(m) for m in bad)
    return None


@bp.post("")
@require_auth("admin")
def create_user():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    role = body.get("role")
    name = body.get("name")
    phone = body.get("phone")
    cities = body.get("cities") or []
    mids, merr = _coerce_manager_ids(body, role)
    if merr:
        return jsonify({"error": merr}), 400

    if not email or role not in VALID_ROLES:
        return jsonify({"error": "email and valid role required"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            verr = _validate_managers_exist(cur, mids)
            if verr:
                return jsonify({"error": verr}), 400
            cur.execute(
                """INSERT INTO users (email, name, phone, role, cities, manager_ids, is_active)
                   VALUES (%s, %s, %s, %s, %s, %s, TRUE)
                   ON CONFLICT (email) DO UPDATE
                     SET role = EXCLUDED.role,
                         name = COALESCE(EXCLUDED.name, users.name),
                         phone = COALESCE(EXCLUDED.phone, users.phone),
                         cities = EXCLUDED.cities,
                         manager_ids = EXCLUDED.manager_ids,
                         is_active = TRUE
                   RETURNING *""",
                (email, name, phone, role, cities, mids or None),
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
    allowed = {"name", "phone", "role", "cities", "is_active", "society", "micro_market"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if "role" in updates and updates["role"] not in VALID_ROLES:
        return jsonify({"error": "invalid role"}), 400
    # Array scope fields — normalise null -> empty array.
    for arr_field in ("cities", "society", "micro_market"):
        if arr_field in updates and updates[arr_field] is None:
            updates[arr_field] = []
    wants_manager = "manager_ids" in body or "manager" in body

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE id = %s FOR UPDATE", (user_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "not found"}), 404
            # Manager(s): only RMs have them; a role change away from rm clears them.
            eff_role = updates.get("role", existing["role"])
            if eff_role != "rm" and (wants_manager or "role" in updates):
                updates["manager_ids"] = None
            elif eff_role == "rm" and wants_manager:
                mids, merr = _coerce_manager_ids(body, "rm")
                if merr:
                    return jsonify({"error": merr}), 400
                if user_id in (mids or []):
                    return jsonify({"error": "a user cannot be their own manager"}), 400
                verr = _validate_managers_exist(cur, mids)
                if verr:
                    return jsonify({"error": verr}), 400
                updates["manager_ids"] = mids or None
            if not updates:
                return jsonify({"error": "no editable fields"}), 400
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
        # Scope changed → refresh this user's cached society coverage.
        if any(k in updates for k in ("cities", "society", "micro_market")):
            try:
                recompute_assigned_societies(conn, [user_id])
            except Exception:
                log.exception("recompute assigned_societies failed for user %s", user_id)
        return jsonify(row)
    finally:
        conn.close()


@bp.post("/recompute-societies")
@require_auth("admin")
def recompute_societies():
    """Rebuild assigned_societies for every user (initial backfill / after a
    master_societies change). Returns { updated }."""
    conn = get_conn()
    try:
        n = recompute_assigned_societies(conn)
        return jsonify({"updated": n})
    finally:
        conn.close()


@bp.get("/clashed-societies")
@require_auth("admin", "manager")
def clashed_societies():
    """Societies covered by MORE THAN ONE active RM — the scope overlaps that
    cause a lead to be matched to multiple RMs. Reads users.assigned_societies."""
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT s.society, COUNT(*) AS n, "
                "  json_agg(json_build_object("
                "     'id', u.id, 'name', COALESCE(NULLIF(TRIM(u.name), ''), u.email)) "
                "   ORDER BY u.name NULLS LAST, u.email) AS rms "
                "FROM users u, unnest(u.assigned_societies) AS s(society) "
                "WHERE u.role = 'rm' AND u.is_active = TRUE "
                "GROUP BY s.society HAVING COUNT(*) > 1 "
                "ORDER BY COUNT(*) DESC, s.society"
            )
            rows = cur.fetchall()
        return jsonify({"items": rows})
    finally:
        conn.close()
