"""Visit Scheduled <-> Forms app integration.

Outbound: when stage flips to visit_scheduled, the frontend calls
  POST /api/visits/schedule { oh_id, schedule_date, schedule_time, field_exec_phone }
which forwards to FORMS_APP_URL/api/external/schedule with INTERNAL_API_KEY.

Inbound webhook: Forms app calls
  POST /api/visits/forms-webhook  (X-Internal-Key)
to mark visits as completed (or rescheduled/cancelled) and flip our stage.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import requests
from flask import Blueprint, g, jsonify, request

IST = timezone(timedelta(hours=5, minutes=30))

from .. import config
from ..db import get_conn, get_props_conn
from ..services.activity import log as log_activity
from .auth import require_auth

bp = Blueprint("visits", __name__, url_prefix="/api/visits")


@bp.get("/field-execs")
@require_auth("admin", "manager", "rm")
def list_field_execs():
    """Field executives = active rows in properties.users with can_visit=true."""
    conn = get_props_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """SELECT id, name, phone, email
                   FROM users
                   WHERE can_visit = TRUE AND is_active = TRUE AND phone IS NOT NULL
                   ORDER BY name"""
            )
            rows = cur.fetchall()
        return jsonify({"items": rows})
    finally:
        conn.close()


@bp.post("/schedule")
@require_auth("admin", "manager", "rm")
def schedule_visit():
    body = request.get_json(silent=True) or {}
    oh_id = body.get("oh_id")
    # Schedule is split into separate date / time strings (HTML inputs send
    # them that way, and the Forms app wants them separately too).
    schedule_date = body.get("schedule_date")
    schedule_time = body.get("schedule_time")
    field_exec_phone = body.get("field_exec_phone")

    if not oh_id or not schedule_date or not schedule_time or not field_exec_phone:
        return jsonify({
            "error": "oh_id, schedule_date, schedule_time, field_exec_phone required"
        }), 400
    if not config.FORMS_APP_URL or not config.INTERNAL_API_KEY:
        return jsonify({"error": "forms integration not configured"}), 500

    try:
        visit_at = datetime.fromisoformat(f"{schedule_date}T{schedule_time}").replace(tzinfo=IST)
    except ValueError:
        return jsonify({"error": f"invalid schedule_date/time: {schedule_date} {schedule_time}"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM inventory WHERE oh_id = %s", (oh_id,))
            inv = cur.fetchone()
            if not inv:
                return jsonify({"error": "inventory not found"}), 404

            # The Forms app's schema (lead_id / first_name / contact_no /
            # configuration / etc.) is independent of our column names, so we
            # adapt here. Keep external_id alongside lead_id so the existing
            # forms-webhook (which reads external_id) keeps working in case
            # Forms echoes either key back.
            seller_first = (inv.get("seller_name") or "").strip().split(" ", 1)[0]
            configuration = (
                f"{inv['bedrooms']} BHK" if inv.get("bedrooms") is not None else ""
            )
            payload = {
                "lead_id":        oh_id,
                "external_id":    oh_id,
                # Forms app accepts only {"CP", "Direct", "CP Listing"}. Every
                # row scheduled from this portal is — by definition — sourced
                # via Direct Inventory, regardless of what `inventory.source`
                # (99acres / magicbricks / Website / etc.) actually contains.
                "source":         "Direct",
                "schedule_date":  schedule_date,
                "schedule_time":  schedule_time,
                "first_name":     seller_first,
                "contact_no":     inv.get("seller_phone") or "",
                "society_name":   inv.get("society") or "",
                "area_sqft":      inv.get("area_sqft"),
                "configuration":  configuration,
                "field_exec":     field_exec_phone,
                # extra context the Forms app may use or ignore
                "city":           inv.get("city"),
                "locality":       inv.get("locality"),
                "assigned_by":    g.user["email"],
                "callback_url":   request.host_url.rstrip("/") + "/api/visits/forms-webhook",
            }
            try:
                r = requests.post(
                    f"{config.FORMS_APP_URL}/api/external/schedule",
                    json=payload,
                    headers={"X-Internal-Key": config.INTERNAL_API_KEY},
                    timeout=10,
                )
            except requests.RequestException as e:
                return jsonify({"error": f"forms app unreachable: {e}"}), 502

            if not r.ok:
                # Surface the Forms-app response verbatim so we can debug
                # schema mismatches without redeploying.
                body_text = (r.text or "")[:500]
                try:
                    body_json = r.json()
                except ValueError:
                    body_json = None
                return jsonify({
                    "error": "forms app rejected request",
                    "forms_status": r.status_code,
                    "forms_response": body_json or body_text,
                    "sent_payload": payload,
                }), 502
            try:
                forms_response = r.json()
            except ValueError:
                return jsonify({
                    "error": "forms app returned non-JSON",
                    "forms_response": (r.text or "")[:500],
                }), 502

            visit_id = forms_response.get("visit_id")
            cur.execute(
                """UPDATE inventory SET
                       stage = 'visit_scheduled',
                       forms_visit_id = %s,
                       visit_at = %s,
                       visit_exec = %s
                   WHERE oh_id = %s RETURNING *""",
                (visit_id, visit_at, field_exec_phone, oh_id),
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
                    "schedule_date": schedule_date,
                    "schedule_time": schedule_time,
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
