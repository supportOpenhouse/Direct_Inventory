"""Visit Scheduled <-> Forms app integration.

Outbound: when stage flips to visit_scheduled, the frontend calls
  POST /api/visits/schedule { oh_id, schedule_date, schedule_time, field_exec_phone }
which forwards to FORMS_APP_URL/api/external/schedule with INTERNAL_API_KEY.

Cancel: admin / manager-of-the-assigned-RM / one of the assigned RMs can call
  POST /api/visits/cancel { oh_id, reason, target_stage, follow_up_at?, stage_reason? }
which forwards to FORMS_APP_URL/api/external/cancel and then clears the
forms_visit_id / visit_at / visit_exec columns and moves the lead to the
chosen target_stage.

Inbound webhook: Forms app calls
  POST /api/visits/forms-webhook  (X-Internal-Key)
to mark visits as completed (or rescheduled/cancelled) and flip our stage.

This is the ONLY backend connection the Pipeline / acquisition flow has today.
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


@bp.get("/society-units")
@require_auth("admin", "manager", "rm")
def list_society_units():
    """Existing OpenHouse-owned units in the same society — surfaced as a
    confirmation step before scheduling a visit. Reads the `properties.properties`
    table; society match is case-insensitive (LOWER(TRIM(...))) mirroring
    master_societies / cp_match.
    """
    society = (request.args.get("society") or "").strip()
    if not society:
        return jsonify({"items": []})
    conn = get_props_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """SELECT uid, tower_no, unit_no, area_sqft, configuration, floor
                   FROM properties
                   WHERE LOWER(TRIM(society_name)) = LOWER(TRIM(%s))
                   ORDER BY tower_no NULLS LAST, unit_no NULLS LAST""",
                (society,),
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
    # User-editable ask price in lakhs. None / missing → derive from inv.price.
    # Must round to INT because Forms' demand_price column is integer.
    raw_dp = body.get("demand_price")
    if raw_dp is None or raw_dp == "":
        body_demand_price = None
    else:
        try:
            body_demand_price = round(float(raw_dp))
            if body_demand_price < 0:
                raise ValueError("negative")
        except (TypeError, ValueError):
            return jsonify({"error": f"invalid demand_price: {raw_dp!r}"}), 400

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

            # Adapt Direct columns to Forms' canonical schema.
            configuration = (
                f"{inv['bedrooms']}BHK" if inv.get("bedrooms") is not None else ""
            )
            # Forms' demand_price column is INT lakhs. User-supplied value wins
            # (modal lets them override per visit); fall back to the lead's own
            # price rounded to lakhs. round() also fixes float division noise.
            if body_demand_price is not None:
                demand_price_lakhs = body_demand_price
            elif inv.get("price") in (None, ""):
                demand_price_lakhs = None
            else:
                demand_price_lakhs = round(float(inv["price"]) / 100000)

            # Forms app's city enum treats Greater Noida as part of Noida.
            inv_city = inv.get("city") or ""
            payload_city = "Noida" if inv_city == "Greater Noida" else inv_city

            payload = {
                "lead_id":        oh_id,
                "city":           payload_city,
                # Forms accepts {"CP", "Direct", "CP Listing"}; rows scheduled
                # from this portal are by definition Direct.
                "source":         "Direct",
                "schedule_date":  schedule_date,
                "schedule_time":  schedule_time,
                "first_name":     (inv.get("seller_name") or "").strip(),
                "contact_no":     inv.get("seller_phone") or "",
                "society_name":   inv.get("society") or "",
                "locality":       inv.get("locality") or "",
                "area_sqft":      "" if inv.get("area_sqft") is None else str(inv["area_sqft"]),
                "demand_price":   demand_price_lakhs,
                "configuration":  configuration,
                "unit_no":        inv.get("unit_no") or "",
                "tower_no":       inv.get("tower") or "",
                "floor":          inv.get("floor") or "",
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
            # `prev` captures the pre-update stage in the same statement (CTEs see
            # the snapshot before the UPDATE), so we can log a proper stage_change.
            cur.execute(
                """WITH prev AS (SELECT stage FROM inventory WHERE oh_id = %s)
                   UPDATE inventory SET
                       stage = 'visit_scheduled',
                       forms_visit_id = %s,
                       visit_at = %s,
                       visit_exec = %s
                   WHERE oh_id = %s
                   RETURNING *, (SELECT stage FROM prev) AS prev_stage""",
                (oh_id, visit_id, visit_at, field_exec_phone, oh_id),
            )
            row = cur.fetchone()
            old_stage = row.pop("prev_stage", None)
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
            # Also log the stage transition as a stage_change so it's visible to
            # the morning-cohort / NEW-badge reconstructions (which key on
            # before/after_value). Skip if the stage didn't actually change.
            if old_stage and old_stage != "visit_scheduled":
                log_activity(
                    cur,
                    actor_user_id=g.user["id"],
                    actor_email=g.user["email"],
                    entity_type="inventory",
                    entity_id=oh_id,
                    action="stage_change",
                    field="stage",
                    before_value=old_stage,
                    after_value="visit_scheduled",
                    metadata={"via": "visit_schedule"},
                )
        return jsonify(row)
    finally:
        conn.close()


# Stages a lead may be moved to when a visit is cancelled. Anything else is
# rejected at the API boundary — cancelling into visit_completed / offer_given
# / another visit_scheduled doesn't make sense. `rejected_post_visit` is the
# supply-tracker terminal a cancelled visit lands in (stage_reason=visit_cancelled),
# matching what the supply-sync would derive from cp_inventory_status.
CANCEL_TARGET_STAGES = {"qualified", "call_not_received", "follow_up", "rejected", "rejected_post_visit"}


@bp.post("/cancel")
@require_auth("admin", "manager", "rm")
def cancel_visit():
    """Cancel a previously-scheduled visit. Admin / manager-of-the-assigned-RM /
    one of the assigned RMs may call this. Forwards the cancel to the Forms
    app, clears visit columns on our row, moves the lead to `target_stage`,
    and records the supplied `reason` in activity_log."""
    user = g.user
    body = request.get_json(silent=True) or {}
    oh_id        = (body.get("oh_id") or "").strip()
    reason       = (body.get("reason") or "").strip()
    target_stage = (body.get("target_stage") or "").strip()
    follow_up_at = body.get("follow_up_at") or None
    stage_reason = (body.get("stage_reason") or "").strip() or None

    if not oh_id:
        return jsonify({"error": "oh_id required"}), 400
    if not reason:
        return jsonify({"error": "reason required"}), 400
    if target_stage not in CANCEL_TARGET_STAGES:
        return jsonify({
            "error": f"invalid target_stage: {target_stage!r}",
            "allowed": sorted(CANCEL_TARGET_STAGES),
        }), 400
    if target_stage == "rejected":
        # Reuse the same reason set the inventory PATCH endpoint accepts.
        from .inventory._common import VALID_REJECT_REASONS
        if not stage_reason or stage_reason not in VALID_REJECT_REASONS:
            return jsonify({"error": "stage_reason required (and must be valid) when target_stage=rejected"}), 400
    if target_stage in ("call_not_received", "follow_up") and not follow_up_at:
        return jsonify({"error": f"follow_up_at required when target_stage={target_stage}"}), 400
    if not config.FORMS_APP_URL or not config.INTERNAL_API_KEY:
        return jsonify({"error": "forms integration not configured"}), 500

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM inventory WHERE oh_id = %s FOR UPDATE", (oh_id,))
            inv = cur.fetchone()
            if not inv:
                return jsonify({"error": "inventory not found"}), 404
            if inv.get("stage") != "visit_scheduled":
                return jsonify({
                    "error": f"can only cancel from visit_scheduled (currently {inv.get('stage')!r})",
                }), 409
            if not inv.get("forms_visit_id") and not inv.get("visit_at"):
                # Defensive: no Forms record to cancel against — refuse rather than
                # silently flip our row out of visit_scheduled.
                return jsonify({"error": "no scheduled visit on file for this oh_id"}), 409

            # Permission check.
            assigned_rm_ids = inv.get("assigned_rm_ids") or []
            allowed = False
            if user["role"] == "admin":
                allowed = True
            elif user["role"] == "rm" and user["id"] in assigned_rm_ids:
                allowed = True
            elif user["role"] == "manager" and assigned_rm_ids:
                # Manager may cancel iff one of the assigned RMs reports to them.
                cur.execute(
                    "SELECT 1 FROM users WHERE id = ANY(%s) AND manager = %s LIMIT 1",
                    (assigned_rm_ids, user["id"]),
                )
                allowed = cur.fetchone() is not None
            if not allowed:
                return jsonify({"error": "not authorized to cancel this visit"}), 403

            # Outbound to Forms app first — if it fails we leave our row alone so
            # the user can retry. Forms /cancel is idempotent so retries are safe.
            payload = {
                "lead_id":     oh_id,
                "reason":      reason,
                "actor_email": user["email"],
                "actor_name":  user.get("name") or user["email"],
            }
            try:
                r = requests.post(
                    f"{config.FORMS_APP_URL}/api/external/cancel",
                    json=payload,
                    headers={"X-Internal-Key": config.INTERNAL_API_KEY},
                    timeout=10,
                )
            except requests.RequestException as e:
                return jsonify({"error": f"forms app unreachable: {e}"}), 502
            if not r.ok:
                try:    forms_body = r.json()
                except ValueError: forms_body = (r.text or "")[:500]
                return jsonify({
                    "error": "forms app rejected cancel",
                    "forms_status": r.status_code,
                    "forms_response": forms_body,
                }), 502

            # Clear visit columns + move the lead. follow_up_at only applies to
            # the two stages that need it; we set NULL for the rest so a lingering
            # date from a prior follow_up cycle doesn't bleed through.
            new_follow_up = follow_up_at if target_stage in ("call_not_received", "follow_up") else None
            new_stage_reason = stage_reason if target_stage in ("rejected", "rejected_post_visit") else None
            cur.execute(
                """UPDATE inventory
                      SET stage = %s,
                          stage_reason = %s,
                          follow_up_at = %s,
                          forms_visit_id = NULL,
                          visit_at = NULL,
                          visit_exec = NULL
                    WHERE oh_id = %s
                    RETURNING *""",
                (target_stage, new_stage_reason, new_follow_up, oh_id),
            )
            row = cur.fetchone()

            log_activity(
                cur,
                actor_user_id=user["id"],
                actor_email=user["email"],
                entity_type="inventory",
                entity_id=oh_id,
                action="visit_cancelled",
                metadata={
                    "reason": reason,
                    "target_stage": target_stage,
                    "follow_up_at": follow_up_at,
                    "stage_reason": stage_reason,
                    "prev_forms_visit_id": inv.get("forms_visit_id"),
                    "prev_visit_at": inv["visit_at"].isoformat() if inv.get("visit_at") else None,
                    "prev_visit_exec": inv.get("visit_exec"),
                },
            )
            log_activity(
                cur,
                actor_user_id=user["id"],
                actor_email=user["email"],
                entity_type="inventory",
                entity_id=oh_id,
                action="stage_change",
                field="stage",
                before_value="visit_scheduled",
                after_value=target_stage,
                metadata={"via": "visit_cancel"},
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
