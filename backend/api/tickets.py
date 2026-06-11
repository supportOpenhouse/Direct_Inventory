"""Property tickets — admin/manager raise an issue on a property, the assigned
RM replies, back-and-forth until the creator/admin closes it.

Routes (all under /api/tickets):
  GET    /                  list (scoped); filters: oh_id, status, scope=action
  GET    /<id>              one ticket + full message thread (scoped)
  POST   /                  create {oh_id, title, summary}        (admin, manager)
  POST   /<id>/reply        append {body}                         (assigned RM / creator / admin)
  POST   /<id>/close        close                                 (creator / admin)
  POST   /<id>/reopen       reopen                                (creator / admin)
  GET    /pending-count     {count} = "needs my action"           (all)

Visibility: admin sees all; manager sees tickets they created; rm sees tickets
assigned to them. `awaiting` tracks whose turn it is (see migration 028).
"""
from __future__ import annotations

import json
import uuid as _uuid
from datetime import datetime, timezone

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from ..services.activity import log as log_activity
from .auth import require_auth

bp = Blueprint("tickets", __name__, url_prefix="/api/tickets")

# Columns returned by list/get, joined to inventory for property context.
_SELECT = """
  SELECT t.id, t.oh_id, t.title, t.summary, t.status, t.awaiting,
         t.created_by_id, t.created_by_name, t.created_by_email,
         t.assigned_rm_id, t.city, t.messages,
         t.last_activity_at, t.created_at, t.closed_at, t.closed_by_id,
         i.society AS society,
         ru.name AS assigned_rm_name, ru.email AS assigned_rm_email
  FROM tickets t
  LEFT JOIN inventory i ON i.oh_id = t.oh_id
  LEFT JOIN users ru ON ru.id = t.assigned_rm_id
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _visibility(user: dict) -> tuple[str, list]:
    """WHERE fragment limiting which tickets a user may see."""
    role = user["role"]
    if role == "admin":
        return ("TRUE", [])
    if role == "manager":
        # A manager sees tickets they raised AND any ticket on a property whose
        # assigned RM reports to them — even ones an admin raised.
        return (
            "(t.created_by_id = %s OR EXISTS ("
            "  SELECT 1 FROM users u WHERE u.id = t.assigned_rm_id AND u.manager = %s))",
            [user["id"], user["id"]],
        )
    return ("t.assigned_rm_id = %s", [user["id"]])  # rm


def _action_clause(user: dict) -> tuple[str, list]:
    """WHERE fragment for tickets that need THIS user's action.

    rm           -> open & assigned to me & awaiting my reply
    manager/admin-> open & I created & the RM has replied (awaiting='creator')
    """
    if user["role"] == "rm":
        return ("t.status = 'open' AND t.assigned_rm_id = %s AND t.awaiting = 'rm'", [user["id"]])
    return ("t.status = 'open' AND t.created_by_id = %s AND t.awaiting = 'creator'", [user["id"]])


def pending_count(cur, user: dict) -> int:
    clause, params = _action_clause(user)
    cur.execute(f"SELECT COUNT(*) AS n FROM tickets t WHERE {clause}", params)
    return cur.fetchone()["n"]


def _can_reply(user: dict, ticket: dict) -> bool:
    return (
        user["role"] == "admin"
        or user["id"] == ticket["created_by_id"]
        or user["id"] == ticket["assigned_rm_id"]
    )


def _can_close(user: dict, ticket: dict) -> bool:
    return user["role"] == "admin" or user["id"] == ticket["created_by_id"]


def _fetch_one(cur, ticket_id: int):
    cur.execute(_SELECT + " WHERE t.id = %s", (ticket_id,))
    return cur.fetchone()


@bp.get("")
@require_auth()
def list_tickets():
    vis, params = _visibility(g.user)
    where = [vis]
    oh_id = request.args.get("oh_id")
    if oh_id:
        where.append("t.oh_id = %s")
        params.append(oh_id)
    status = request.args.get("status")  # open | closed | all (default all)
    if status in ("open", "closed"):
        where.append("t.status = %s")
        params.append(status)
    if request.args.get("scope") == "action":
        clause, aparams = _action_clause(g.user)
        where.append(clause)
        params.extend(aparams)

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                _SELECT + " WHERE " + " AND ".join(where) + " ORDER BY t.last_activity_at DESC LIMIT 500",
                params,
            )
            return jsonify({"items": cur.fetchall()})
    finally:
        conn.close()


@bp.get("/pending-count")
@require_auth()
def pending_count_route():
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            return jsonify({"count": pending_count(cur, g.user)})
    finally:
        conn.close()


@bp.get("/<int:ticket_id>")
@require_auth()
def get_ticket(ticket_id: int):
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            t = _fetch_one(cur, ticket_id)
            if not t:
                return jsonify({"error": "not found"}), 404
            vis, params = _visibility(g.user)
            cur.execute(f"SELECT 1 FROM tickets t WHERE t.id = %s AND {vis}", [ticket_id, *params])
            if not cur.fetchone():
                return jsonify({"error": "not found"}), 404
            return jsonify(t)
    finally:
        conn.close()


@bp.post("")
@require_auth("admin", "manager")
def create_ticket():
    """Raise a ticket either ON a property (oh_id → RM resolved from the
    property) or DIRECTLY to an RM (rm_id, no property link). Managers can only
    target RMs on their own team in either mode."""
    body = request.get_json(silent=True) or {}
    oh_id = (body.get("oh_id") or "").strip()
    title = (body.get("title") or "").strip()
    summary = (body.get("summary") or "").strip()
    rm_id = body.get("rm_id") or body.get("assigned_rm_id")
    if not title:
        return jsonify({"error": "title is required"}), 400
    if not oh_id and not rm_id:
        return jsonify({"error": "a property (oh_id) or an RM (rm_id) is required"}), 400

    user = g.user
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            city = None
            if oh_id:
                # Property mode — resolve the RM from the property.
                cur.execute("SELECT oh_id, city, assigned_rm_ids FROM inventory WHERE oh_id = %s", (oh_id,))
                prop = cur.fetchone()
                if not prop:
                    return jsonify({"error": "property not found"}), 404
                rm_ids = prop.get("assigned_rm_ids") or []
                if not rm_ids:
                    return jsonify({"error": "property has no assigned RM to raise a ticket for"}), 400
                assigned_rm_id = rm_ids[0]
                city = prop.get("city")
            else:
                # Direct mode — ticket goes straight to a chosen RM, no property.
                assigned_rm_id = int(rm_id)
                cur.execute("SELECT id, role FROM users WHERE id = %s", (assigned_rm_id,))
                rm = cur.fetchone()
                if not rm or rm["role"] != "rm":
                    return jsonify({"error": "invalid RM"}), 400
                oh_id = None

            # Manager may only raise tickets for RMs who report to them.
            if user["role"] == "manager":
                cur.execute("SELECT manager FROM users WHERE id = %s", (assigned_rm_id,))
                rm = cur.fetchone()
                if not rm or rm["manager"] != user["id"]:
                    return jsonify({"error": "that RM is not in your team"}), 403

            cur.execute(
                """
                INSERT INTO tickets
                  (oh_id, title, summary, status, awaiting,
                   created_by_id, created_by_name, created_by_email,
                   assigned_rm_id, city, messages, last_activity_at)
                VALUES (%s, %s, %s, 'open', 'rm', %s, %s, %s, %s, %s, '[]'::jsonb, NOW())
                RETURNING id
                """,
                (oh_id, title, summary or None, user["id"], user.get("name"),
                 user["email"], assigned_rm_id, city),
            )
            ticket_id = cur.fetchone()["id"]
            # Only property tickets get an inventory activity-log entry.
            if oh_id:
                log_activity(
                    cur,
                    actor_user_id=user["id"], actor_email=user["email"],
                    entity_type="inventory", entity_id=oh_id, action="ticket_created",
                    field="ticket", after_value=title,
                    metadata={"ticket_id": ticket_id, "assigned_rm_id": assigned_rm_id},
                )
            return jsonify(_fetch_one(cur, ticket_id)), 201
    finally:
        conn.close()


@bp.post("/<int:ticket_id>/reply")
@require_auth()
def reply(ticket_id: int):
    text = ((request.get_json(silent=True) or {}).get("body") or "").strip()
    if not text:
        return jsonify({"error": "body is required"}), 400

    user = g.user
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            t = _fetch_one(cur, ticket_id)
            if not t:
                return jsonify({"error": "not found"}), 404
            if not _can_reply(user, t):
                return jsonify({"error": "forbidden"}), 403
            if t["status"] != "open":
                return jsonify({"error": "ticket is closed"}), 409

            msg = {
                "id": str(_uuid.uuid4()),
                "author_id": user["id"],
                "author_name": user.get("name"),
                "author_email": user["email"],
                "author_role": user["role"],
                "body": text,
                "created_at": _now(),
            }
            # An RM reply hands the turn back to the creator; a creator/admin
            # reply hands it to the RM.
            awaiting = "creator" if user["role"] == "rm" else "rm"
            cur.execute(
                "UPDATE tickets "
                "SET messages = COALESCE(messages, '[]'::jsonb) || %s::jsonb, "
                "    awaiting = %s, last_activity_at = NOW() "
                "WHERE id = %s",
                (json.dumps([msg]), awaiting, ticket_id),
            )
            log_activity(
                cur,
                actor_user_id=user["id"], actor_email=user["email"],
                entity_type="inventory", entity_id=t["oh_id"], action="ticket_reply",
                field="ticket", after_value=text,
                metadata={"ticket_id": ticket_id},
            )
            return jsonify(_fetch_one(cur, ticket_id))
    finally:
        conn.close()


@bp.post("/<int:ticket_id>/close")
@require_auth()
def close_ticket(ticket_id: int):
    user = g.user
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            t = _fetch_one(cur, ticket_id)
            if not t:
                return jsonify({"error": "not found"}), 404
            if not _can_close(user, t):
                return jsonify({"error": "forbidden"}), 403
            cur.execute(
                "UPDATE tickets SET status = 'closed', awaiting = NULL, "
                "closed_at = NOW(), closed_by_id = %s, last_activity_at = NOW() WHERE id = %s",
                (user["id"], ticket_id),
            )
            log_activity(
                cur,
                actor_user_id=user["id"], actor_email=user["email"],
                entity_type="inventory", entity_id=t["oh_id"], action="ticket_closed",
                field="ticket", metadata={"ticket_id": ticket_id},
            )
            return jsonify(_fetch_one(cur, ticket_id))
    finally:
        conn.close()


@bp.post("/<int:ticket_id>/reopen")
@require_auth()
def reopen_ticket(ticket_id: int):
    user = g.user
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            t = _fetch_one(cur, ticket_id)
            if not t:
                return jsonify({"error": "not found"}), 404
            if not _can_close(user, t):  # same authority as closing
                return jsonify({"error": "forbidden"}), 403
            cur.execute(
                "UPDATE tickets SET status = 'open', awaiting = 'rm', "
                "closed_at = NULL, closed_by_id = NULL, last_activity_at = NOW() WHERE id = %s",
                (ticket_id,),
            )
            return jsonify(_fetch_one(cur, ticket_id))
    finally:
        conn.close()
