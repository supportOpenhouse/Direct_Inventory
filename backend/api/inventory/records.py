"""Single-row inventory endpoints: get one, visible-rms, create, notes, patch."""
from __future__ import annotations

import json
import uuid as _uuid
from datetime import datetime, timezone

from flask import g, jsonify, request

from ...db import get_conn
from ...services.activity import log as log_activity
from ...services.assignment import resolve_assignment
from ...services.cp_match import MATCH_INPUT_FIELDS
from ...services.oh_id import next_oh_id
from ..auth import require_auth
from ._common import (
    EDITABLE_RAW_FIELDS,
    ONE_WITH_RMS_SQL,
    PRIORITY_ROLES,
    VALID_REJECT_REASONS,
    VALID_STAGES,
    _expand_cities,
    bp,
)


@bp.get("/<oh_id>")
@require_auth()
def get_one(oh_id: str):
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(ONE_WITH_RMS_SQL, (oh_id,))
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "not found"}), 404
            # Pull recent activity for this entity.
            cur.execute(
                """
                SELECT id, actor_email, action, field, before_value, after_value, metadata, created_at
                FROM activity_log
                WHERE entity_type = 'inventory' AND entity_id = %s
                ORDER BY created_at DESC LIMIT 100
                """,
                (oh_id,),
            )
            row["activity"] = cur.fetchall()
        return jsonify(row)
    finally:
        conn.close()


@bp.get("/<oh_id>/visible-rms")
@require_auth("admin", "manager")
def visible_rms(oh_id: str):
    """The RM(s) currently assigned to this property. Admin/manager only.

    Response: { oh_id, rms: [{ id, name, email, via }] }
      `via` is always 'assigned' (kept for response-shape compatibility).
    """
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT oh_id, assigned_rm_ids FROM inventory WHERE oh_id = %s",
                (oh_id,),
            )
            inv = cur.fetchone()
            if inv is None:
                return jsonify({"error": "not found"}), 404
            ids = inv.get("assigned_rm_ids") or []
            if not ids:
                return jsonify({"oh_id": oh_id, "rms": []})
            cur.execute(
                "SELECT id, name, email FROM users WHERE id = ANY(%s) ORDER BY id",
                (list(ids),),
            )
            rms = [
                {"id": r["id"], "name": r["name"], "email": r["email"], "via": "assigned"}
                for r in cur.fetchall()
            ]
    finally:
        conn.close()
    return jsonify({"oh_id": oh_id, "rms": rms})


@bp.post("")
@require_auth("admin", "manager", "rm")
def create_one():
    user = g.user
    body = request.get_json(silent=True) or {}
    # listing_link is no longer required for manual entries — auto-generate if missing.
    required = ["city", "society"]
    for k in required:
        if not body.get(k):
            return jsonify({"error": f"missing field: {k}"}), 400

    fields = {k: body.get(k) for k in EDITABLE_RAW_FIELDS}
    if not fields.get("source"):
        fields["source"] = "Website"

    if not (fields.get("listing_link") or "").strip():
        fields["listing_link"] = f"internal://manual/{_uuid.uuid4()}"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # dedup on listing_link (auto-generated UUIDs are unique by construction;
            # this still catches user-provided duplicates).
            cur.execute("SELECT oh_id FROM inventory WHERE listing_link = %s", (fields["listing_link"],))
            existing = cur.fetchone()
            if existing:
                return jsonify({"error": "listing already exists", "oh_id": existing["oh_id"]}), 409

            oh_id = next_oh_id(cur, fields["city"])

            # POC assignment on create:
            #   rm      — always self (their manager comes from users.manager).
            #   admin   — optional explicit assigned_rm_id (any active rm);
            #             else auto-resolve by society → micro_market.
            #   manager — optional explicit assigned_rm_id but only one of
            #             their own RMs; else auto-resolve.
            requested_rm = body.get("assigned_rm_id")
            if user["role"] == "rm":
                cur.execute("SELECT manager FROM users WHERE id = %s", (user["id"],))
                me = cur.fetchone()
                rm_id = user["id"]
                mgr_id = me["manager"] if me else None
                assign_source = "self"
            elif requested_rm not in (None, "", 0):
                try:
                    requested_rm = int(requested_rm)
                except (TypeError, ValueError):
                    return jsonify({"error": "invalid assigned_rm_id"}), 400
                cur.execute(
                    "SELECT id, manager FROM users "
                    "WHERE id = %s AND role = 'rm' AND is_active = TRUE",
                    (requested_rm,),
                )
                rm = cur.fetchone()
                if not rm:
                    return jsonify({"error": "invalid assigned_rm_id"}), 400
                if user["role"] == "manager" and rm["manager"] != user["id"]:
                    return jsonify({"error": "managers can only assign their own RMs"}), 403
                rm_id, mgr_id = rm["id"], rm["manager"]
                assign_source = "manual"
            else:
                rm_id, mgr_id = resolve_assignment(
                    cur, city=fields["city"],
                    locality=fields.get("locality"), society=fields.get("society"),
                )
                assign_source = "auto"

            cur.execute(
                """
                INSERT INTO inventory (
                    oh_id, source, city, locality, society, bedrooms, area_sqft,
                    floor, tower, unit_no,
                    price, seller_name, seller_phone, posting_date, listing_link,
                    stage, assigned_rm_ids, assigned_mgr_id, follow_up_at, last_synced_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s,
                          %s, %s, %s,
                          %s, %s, %s, %s, %s,
                          'lead', %s, %s,
                          (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE, NULL)
                RETURNING *
                """,
                (
                    oh_id, fields["source"], fields["city"], fields.get("locality"),
                    fields.get("society"), fields.get("bedrooms"), fields.get("area_sqft"),
                    fields.get("floor"), fields.get("tower"), fields.get("unit_no"),
                    fields.get("price"), fields.get("seller_name"),
                    fields.get("seller_phone"), fields.get("posting_date"), fields["listing_link"],
                    [rm_id] if rm_id else [], mgr_id,
                ),
            )
            row = cur.fetchone()

            log_activity(
                cur,
                actor_user_id=user["id"],
                actor_email=user["email"],
                entity_type="inventory",
                entity_id=oh_id,
                action="create",
                metadata={
                    "source": fields["source"],
                    "assigned_rm": rm_id,
                    "assigned_mgr": mgr_id,
                    "assign_source": assign_source,
                },
            )
        return jsonify(row), 201
    finally:
        conn.close()


@bp.post("/<oh_id>/notes")
@require_auth("admin", "manager", "rm")
def add_note(oh_id: str):
    """Append a comment to inventory.note_thread.

    Body: { "body": "<text>" }. Server stamps author + timestamp.

    Response (201): { "note": <new>, "note_thread": <full updated array> }.
    """
    body_json = request.get_json(silent=True) or {}
    text = (body_json.get("body") or "").strip()
    if not text:
        return jsonify({"error": "body is required"}), 400

    user = g.user
    note = {
        "id":           str(_uuid.uuid4()),
        "author_id":    user["id"],
        "author_name":  user.get("name"),
        "author_email": user["email"],
        "body":         text,
        "created_at":   datetime.now(timezone.utc).isoformat(),
    }

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE inventory "
                "SET note_thread = COALESCE(note_thread, '[]'::jsonb) || %s::jsonb "
                "WHERE oh_id = %s "
                "RETURNING note_thread",
                (json.dumps([note]), oh_id),
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "not found"}), 404
            log_activity(
                cur,
                actor_user_id=user["id"],
                actor_email=user["email"],
                entity_type="inventory",
                entity_id=oh_id,
                action="note_added",
                field="note",
                after_value=text,
                metadata={
                    "note_id": note["id"],
                    "author_name": user.get("name"),
                },
            )
        return jsonify({"note": note, "note_thread": row["note_thread"]}), 201
    finally:
        conn.close()


@bp.patch("/<oh_id>")
@require_auth("admin", "manager", "rm")
def update_one(oh_id: str):
    """Patch any subset of fields. Each changed field gets its own activity row."""
    user = g.user
    body = request.get_json(silent=True) or {}

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM inventory WHERE oh_id = %s FOR UPDATE", (oh_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "not found"}), 404

            # Any authenticated admin/manager/rm can edit any field they have UI
            # access to. Cross-assignment edits are intentionally allowed; the
            # per-field activity_log row (with actor_email + role) is the audit
            # trail. Priority is the one exception — still admin/manager only,
            # enforced below.
            cross_assignment_edit = (
                user["role"] == "rm"
                and user["id"] not in (existing.get("assigned_rm_ids") or [])
            ) or (
                user["role"] == "manager"
                and existing["city"] not in _expand_cities(user.get("cities") or [])
            )

            updates = []
            params: list = []
            requires_visit_form = False
            invalidate_cp_match = False

            # Note: `notes` (the old free-text column) is intentionally NOT
            # editable through this endpoint — comments live on `note_thread`
            # and go through POST /<oh_id>/notes instead.
            allowed = EDITABLE_RAW_FIELDS | {
                "stage", "stage_reason", "assigned_rm_ids", "assigned_mgr_id",
                "follow_up_at", "priority", "star_color", "cp_match",
            }
            # Accept the legacy single-id key as a one-element array.
            if "assigned_rm_id" in body and "assigned_rm_ids" not in body:
                v = body.get("assigned_rm_id")
                body = dict(body)
                body["assigned_rm_ids"] = [int(v)] if v else []
                body.pop("assigned_rm_id", None)
            for k, v in body.items():
                if k not in allowed:
                    continue
                # Re-follow-up: the lead stays in 'follow_up' but a NEW follow-up
                # date is set. The stage column doesn't change (so no UPDATE for
                # it), yet it's genuine work — emit a stage_change anyway so it
                # surfaces in the user report (which only counts stage_change
                # rows). The follow_up_at change is written/logged on its own
                # iteration below.
                if k == "stage" and v == "follow_up" and existing.get("stage") == "follow_up":
                    new_fu = body.get("follow_up_at")
                    if new_fu and str(existing.get("follow_up_at") or "")[:10] != str(new_fu)[:10]:
                        log_activity(
                            cur,
                            actor_user_id=user["id"],
                            actor_email=user["email"],
                            entity_type="inventory",
                            entity_id=oh_id,
                            action="stage_change",
                            field="stage",
                            before_value="follow_up",
                            after_value="follow_up",
                            metadata={
                                "actor_role": user["role"],
                                "cross_assignment": cross_assignment_edit,
                                "re_follow_up": True,
                            },
                        )
                    continue
                if existing.get(k) == v:
                    continue
                if k == "priority" and user["role"] not in PRIORITY_ROLES:
                    return jsonify({"error": "only admin/manager can change priority"}), 403
                if k == "priority":
                    v = bool(v)
                if k == "star_color":
                    if user["role"] not in PRIORITY_ROLES:
                        return jsonify({"error": "only admin/manager can change star_color"}), 403
                    if v in ("", None):
                        v = None
                    elif v not in ("red", "green", "yellow", "none"):
                        return jsonify({"error": f"invalid star_color: {v}"}), 400
                if k == "cp_match":
                    # Manual override that mirrors the auto-scan verdict. Same role
                    # gate as star_color since they're set together from the picker.
                    if user["role"] not in PRIORITY_ROLES:
                        return jsonify({"error": "only admin/manager can change cp_match"}), 403
                    if v in ("", None):
                        v = None
                    elif v not in ("perfect", "partial", "none"):
                        return jsonify({"error": f"invalid cp_match: {v}"}), 400
                if k == "stage":
                    if v not in VALID_STAGES:
                        return jsonify({"error": f"invalid stage: {v}"}), 400
                    if v == "rejected" and not body.get("stage_reason") and not existing.get("stage_reason"):
                        return jsonify({"error": "stage_reason required when stage=rejected"}), 400
                    if v == "visit_scheduled":
                        requires_visit_form = True
                if k == "stage_reason" and v and v not in VALID_REJECT_REASONS:
                    return jsonify({"error": f"invalid stage_reason: {v}"}), 400
                if k in MATCH_INPUT_FIELDS:
                    invalidate_cp_match = True
                updates.append(f"{k} = %s")
                params.append(v)
                log_activity(
                    cur,
                    actor_user_id=user["id"],
                    actor_email=user["email"],
                    entity_type="inventory",
                    entity_id=oh_id,
                    action=("stage_change" if k == "stage" else "update"),
                    field=k,
                    before_value=existing.get(k),
                    after_value=v,
                    metadata={
                        "actor_role": user["role"],
                        "cross_assignment": cross_assignment_edit,
                    },
                )

            if not updates:
                return jsonify({"oh_id": oh_id, "noop": True})

            # If any match-determining field changed, drop the persisted verdict so
            # the next scan reclassifies. Cheap NULL is better than a stale label.
            if invalidate_cp_match:
                updates.append("cp_match = NULL")

            params.append(oh_id)
            cur.execute(
                f"UPDATE inventory SET {', '.join(updates)} WHERE oh_id = %s RETURNING *",
                params,
            )
            row = cur.fetchone()
        return jsonify({"item": row, "requires_visit_form": requires_visit_form})
    finally:
        conn.close()
