"""Visit Scheduled <-> Forms app integration.

Outbound: when stage flips to visit_scheduled, the frontend calls
  POST /api/visits/schedule { oh_id, scheduled_at, field_exec_phone }
which forwards to FORMS_APP_URL/api/external/schedule with INTERNAL_API_KEY.

Inbound webhook: Forms app calls
  POST /api/visits/forms-webhook  (X-Internal-Key)
to mark visits as completed (or rescheduled/cancelled) and flip our stage.
"""
from __future__ import annotations

import requests
from flask import Blueprint, g, jsonify, request

from .. import config
from ..db import get_conn
from ..services.activity import log as log_activity
from .auth import require_auth

bp = Blueprint("visits", __name__, url_prefix="/api/visits")


@bp.post("/schedule")
@require_auth("admin", "manager", "rm")
def schedule_visit():
    body = request.get_json(silent=True) or {}
    oh_id = body.get("oh_id")
    scheduled_at = body.get("scheduled_at")
    field_exec_phone = body.get("field_exec_phone")

    if not oh_id or not scheduled_at or not field_exec_phone:
        return jsonify({"error": "oh_id, scheduled_at, field_exec_phone required"}), 400
    if not config.FORMS_APP_URL or not config.INTERNAL_API_KEY:
        return jsonify({"error": "forms integration not configured"}), 500

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM inventory WHERE oh_id = %s", (oh_id,))
            inv = cur.fetchone()
            if not inv:
                return jsonify({"error": "inventory not found"}), 404

            # Forward to Forms app
            try:
                r = requests.post(
                    f"{config.FORMS_APP_URL}/api/external/schedule",
                    json={
                        "external_id": oh_id,
                        "city": inv["city"],
                        "locality": inv["locality"],
                        "society": inv["society"],
                        "scheduled_at": scheduled_at,
                        "field_exec_phone": field_exec_phone,
                        "assigned_by": g.user["email"],
                        "callback_url": request.host_url.rstrip("/") + "/api/visits/forms-webhook",
                    },
                    headers={"X-Internal-Key": config.INTERNAL_API_KEY},
                    timeout=10,
                )
                r.raise_for_status()
                forms_response = r.json()
            except requests.RequestException as e:
                return jsonify({"error": f"forms app error: {e}"}), 502

            visit_id = forms_response.get("visit_id")
            cur.execute(
                """UPDATE inventory SET
                       stage = 'visit_scheduled',
                       forms_visit_id = %s,
                       visit_at = %s,
                       visit_exec = %s
                   WHERE oh_id = %s RETURNING *""",
                (visit_id, scheduled_at, field_exec_phone, oh_id),
            )
            row = cur.fetchone()
            log_activity(
                cur,
                actor_user_id=g.user["id"],
                actor_email=g.user["email"],
                entity_type="inventory",
                entity_id=oh_id,
                action="visit_scheduled",
                metadata={
                    "scheduled_at": scheduled_at,
                    "field_exec_phone": field_exec_phone,
                    "forms_visit_id": visit_id,
                },
            )
        return jsonify(row)
    finally:
        conn.close()


@bp.post("/forms-webhook")
def forms_webhook():
    """Called by Forms app when a visit's status changes."""
    key = request.headers.get("X-Internal-Key", "")
    if not config.INTERNAL_API_KEY or key != config.INTERNAL_API_KEY:
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    oh_id = body.get("external_id")
    status = body.get("status")  # 'completed' | 'cancelled' | 'rescheduled'
    if not oh_id or not status:
        return jsonify({"error": "external_id and status required"}), 400

    new_stage = None
    if status == "completed":
        new_stage = "visit_completed"
    elif status == "cancelled":
        new_stage = "qualified"  # back to top of pipeline; admin can re-route
    elif status == "rescheduled":
        new_stage = "visit_scheduled"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT stage FROM inventory WHERE oh_id = %s FOR UPDATE", (oh_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "inventory not found"}), 404

            if new_stage and existing["stage"] != new_stage:
                cur.execute(
                    "UPDATE inventory SET stage = %s WHERE oh_id = %s",
                    (new_stage, oh_id),
                )
                log_activity(
                    cur, actor_user_id=None, actor_email="system:forms-webhook",
                    entity_type="inventory", entity_id=oh_id, action="stage_change",
                    field="stage", before_value=existing["stage"], after_value=new_stage,
                    metadata={"forms_status": status, **body},
                )
        return jsonify({"ok": True, "new_stage": new_stage})
    finally:
        conn.close()
