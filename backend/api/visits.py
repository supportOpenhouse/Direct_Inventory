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


@bp.get("/assignees")
@require_auth("admin", "manager", "rm")
def list_assignees():
    """Active users from the shared properties.users table — same source the
    Forms app validates `assigned_by` against. The admin's "Assigned By"
    dropdown reads from here so it can only ever pick an email that Forms
    will accept.
    """
    conn = get_props_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """SELECT id, name, email
                   FROM users
                   WHERE is_active = TRUE AND email IS NOT NULL
                   ORDER BY name NULLS LAST, email"""
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

    # "Assigned By" — for managers/RMs this is implicitly themselves. Admins
    # don't usually own leads, so the modal forces them to pick a manager/RM
    # to mark as the assignee; if missing we reject so the Forms app gets a
    # meaningful name (and not an admin's email).
    if g.user["role"] == "admin":
        assigned_by_email = (body.get("assigned_by_email") or "").strip().lower()
        if not assigned_by_email:
            return jsonify({"error": "assigned_by_email required when admin schedules a visit"}), 400
    else:
        assigned_by_email = g.user["email"]

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

            # Short-circuit if a visit already exists for this row. Without this
            # the request would hit Forms a second time; Forms typically dedupes
            # on lead_id and returns an error, but we don't want to depend on
            # that — and we want the UI to show the existing visit details
            # instead of a generic failure.
            if inv.get("forms_visit_id") or inv.get("visit_at"):
                return jsonify({
                    "error": "visit already scheduled for this oh_id",
                    "existing_visit": {
                        "forms_visit_id": inv.get("forms_visit_id"),
                        "visit_at": inv["visit_at"].isoformat() if inv.get("visit_at") else None,
                        "visit_exec": inv.get("visit_exec"),
                        "stage": inv.get("stage"),
                    },
                }), 409

            # Forms validates assigned_by and field_exec by NAME (not email or
            # phone). Resolve both against properties.users — the same source
            # the modal dropdowns are populated from. Fail fast with a clear
            # message if either can't be resolved.
            props_conn = get_props_conn()
            try:
                with props_conn.cursor() as pcur:
                    pcur.execute(
                        "SELECT name FROM users WHERE email = %s AND is_active = TRUE LIMIT 1",
                        (assigned_by_email,),
                    )
                    ab = pcur.fetchone()
                    pcur.execute(
                        "SELECT name FROM users WHERE phone = %s AND can_visit = TRUE AND is_active = TRUE LIMIT 1",
                        (field_exec_phone,),
                    )
                    fx = pcur.fetchone()
            finally:
                props_conn.close()
            if not ab or not ab.get("name"):
                return jsonify({
                    "error": f"assigned_by user not found / inactive: {assigned_by_email}"
                }), 400
            if not fx or not fx.get("name"):
                return jsonify({
                    "error": f"field exec not found / can't visit: {field_exec_phone}"
                }), 400
            assigned_by_name = ab["name"]
            field_exec_name = fx["name"]

            # Adapt Direct columns to Forms' canonical schema. Numeric fields
            # go out as strings to match the canonical sample.
            seller_parts = (inv.get("seller_name") or "").strip().split(" ", 1)
            seller_first = seller_parts[0] if seller_parts else ""
            seller_last = seller_parts[1] if len(seller_parts) > 1 else ""
            configuration = (
                f"{inv['bedrooms']}BHK" if inv.get("bedrooms") is not None else ""
            )

            def _s(v):
                return "" if v is None else str(v)

            payload = {
                "lead_id":        oh_id,
                "city":           inv.get("city") or "",
                # Forms accepts {"CP", "Direct", "CP Listing"}; rows scheduled
                # from this portal are by definition Direct.
                "source":         "Direct",
                "schedule_date":  schedule_date,
                "schedule_time":  schedule_time,
                "first_name":     seller_first,
                "last_name":      seller_last,
                "contact_no":     inv.get("seller_phone") or "",
                "society_name":   inv.get("society") or "",
                "locality":       inv.get("locality") or "",
                "area_sqft":      _s(inv.get("area_sqft")),
                "demand_price":   _s(inv.get("price")),
                "configuration":  configuration,
                "unit_no":        inv.get("unit_no") or "",
                "tower_no":       inv.get("tower") or "",
                "floor":          _s(inv.get("floor")),
                "assigned_by":    assigned_by_name,
                "field_exec":     field_exec_name,
                "actor_email":    g.user["email"],
                "actor_name":     g.user.get("name") or g.user["email"],
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
                    "field_exec_name": field_exec_name,
                    "assigned_by_email": assigned_by_email,
                    "assigned_by_name": assigned_by_name,
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
