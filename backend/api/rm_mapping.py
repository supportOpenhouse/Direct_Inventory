"""Admin-only RM/locality mapping CRUD."""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from ..services.activity import log as log_activity
from .auth import require_auth

bp = Blueprint("rm_mapping", __name__, url_prefix="/api/rm-mapping")


@bp.get("")
@require_auth("admin", "manager")
def list_mappings():
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                SELECT m.*,
                       rm.name AS rm_name, rm.email AS rm_email,
                       mgr.name AS mgr_name, mgr.email AS mgr_email
                FROM rm_mapping m
                LEFT JOIN users rm  ON rm.id  = m.rm_user_id
                LEFT JOIN users mgr ON mgr.id = m.manager_user_id
                ORDER BY m.city, m.locality NULLS FIRST, m.society NULLS FIRST
            """)
            rows = cur.fetchall()
        return jsonify({"items": rows})
    finally:
        conn.close()


@bp.post("")
@require_auth("admin")
def create_mapping():
    body = request.get_json(silent=True) or {}
    city = (body.get("city") or "").strip()
    locality = (body.get("locality") or "").strip() or None
    society = (body.get("society") or "").strip() or None
    rm_user_id = body.get("rm_user_id")
    manager_user_id = body.get("manager_user_id")

    if not city or not rm_user_id:
        return jsonify({"error": "city and rm_user_id required"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO rm_mapping (city, locality, society, rm_user_id, manager_user_id)
                   VALUES (%s, %s, %s, %s, %s) RETURNING *""",
                (city, locality, society, rm_user_id, manager_user_id),
            )
            row = cur.fetchone()
            log_activity(
                cur, actor_user_id=g.user["id"], actor_email=g.user["email"],
                entity_type="rm_mapping", entity_id=str(row["id"]), action="create",
                metadata={"city": city, "locality": locality, "society": society,
                          "rm_user_id": rm_user_id, "manager_user_id": manager_user_id},
            )
        return jsonify(row), 201
    finally:
        conn.close()


@bp.patch("/<int:mapping_id>")
@require_auth("admin")
def update_mapping(mapping_id: int):
    body = request.get_json(silent=True) or {}
    allowed = {"city", "locality", "society", "rm_user_id", "manager_user_id"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        return jsonify({"error": "no editable fields"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM rm_mapping WHERE id = %s FOR UPDATE", (mapping_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "not found"}), 404
            for k, v in updates.items():
                log_activity(
                    cur, actor_user_id=g.user["id"], actor_email=g.user["email"],
                    entity_type="rm_mapping", entity_id=str(mapping_id), action="update",
                    field=k, before_value=existing.get(k), after_value=v,
                )
            cols = ", ".join(f"{k} = %s" for k in updates.keys())
            cur.execute(f"UPDATE rm_mapping SET {cols} WHERE id = %s RETURNING *",
                        (*updates.values(), mapping_id))
            row = cur.fetchone()
        return jsonify(row)
    finally:
        conn.close()


@bp.delete("/<int:mapping_id>")
@require_auth("admin")
def delete_mapping(mapping_id: int):
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM rm_mapping WHERE id = %s RETURNING id", (mapping_id,))
            if not cur.fetchone():
                return jsonify({"error": "not found"}), 404
            log_activity(
                cur, actor_user_id=g.user["id"], actor_email=g.user["email"],
                entity_type="rm_mapping", entity_id=str(mapping_id), action="delete",
            )
        return jsonify({"ok": True})
    finally:
        conn.close()
