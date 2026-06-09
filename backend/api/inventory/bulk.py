"""Multi-row + admin assignment endpoints: bulk-update, assigned-rms."""
from __future__ import annotations

import json

from flask import g, jsonify, request

from ...db import get_conn
from ...services.activity import log as log_activity, log_many
from ..auth import require_auth
from ._common import (
    BULK_ALLOWED_FIELDS,
    ONE_WITH_RMS_SQL,
    PRIORITY_ROLES,
    VALID_REJECT_REASONS,
    VALID_STAGES,
    _expand_cities,
    bp,
)


@bp.put("/<oh_id>/assigned-rms")
@require_auth("admin")
def set_assigned_rms(oh_id: str):
    """Admin-only: replace the RM(s) assigned to one property.

    Body: { "rm_ids": [int, int, ...] }   (empty array = unassign)

    Validates that every id refers to an active rm. Logs an `assigned_rms`
    activity entry with before / after.
    """
    body = request.get_json(silent=True) or {}
    raw = body.get("rm_ids")
    if not isinstance(raw, list):
        return jsonify({"error": "rm_ids must be a list of integers"}), 400
    try:
        rm_ids = [int(x) for x in raw]
    except (TypeError, ValueError):
        return jsonify({"error": "rm_ids must be integers"}), 400
    # Dedup while preserving order.
    seen = set()
    rm_ids = [x for x in rm_ids if not (x in seen or seen.add(x))]

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT oh_id, assigned_rm_ids FROM inventory WHERE oh_id = %s FOR UPDATE",
                (oh_id,),
            )
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "not found"}), 404
            before_ids = existing.get("assigned_rm_ids") or []

            if rm_ids:
                cur.execute(
                    "SELECT id, manager FROM users "
                    "WHERE id = ANY(%s) AND role = 'rm' AND is_active = TRUE",
                    (rm_ids,),
                )
                rows = cur.fetchall()
                found = {r["id"]: r["manager"] for r in rows}
                bad = [x for x in rm_ids if x not in found]
                if bad:
                    return jsonify({"error": f"invalid or inactive rm ids: {bad}"}), 400
                # Manager from the first assigned RM (lowest position in the list).
                new_mgr = found.get(rm_ids[0])
            else:
                new_mgr = None

            cur.execute(
                "UPDATE inventory SET "
                "  assigned_rm_ids = %s, "
                "  assigned_mgr_id = COALESCE(%s, assigned_mgr_id) "
                "WHERE oh_id = %s",
                (rm_ids, new_mgr, oh_id),
            )
            log_activity(
                cur,
                actor_user_id=g.user["id"],
                actor_email=g.user["email"],
                entity_type="inventory",
                entity_id=oh_id,
                action="assigned_rms",
                field="assigned_rm_ids",
                before_value=json.dumps(list(before_ids)),
                after_value=json.dumps(rm_ids),
            )

            # Return the full row in the same shape the list endpoint emits.
            cur.execute(ONE_WITH_RMS_SQL, (oh_id,))
            row = cur.fetchone()
        return jsonify({"item": row})
    finally:
        conn.close()


@bp.post("/bulk-update")
@require_auth("admin", "manager", "rm")
def bulk_update():
    """Update the same field(s) on many inventory rows in one call.

    Body: { oh_ids: [...], updates: { stage?, stage_reason?, assigned_rm_ids?,
            assigned_mgr_id?, follow_up_at?, priority? } }

    Returns: { requested, updated, skipped_forbidden: [oh_id...], not_found: [oh_id...] }

    Visibility rules apply (rm: own rows only; manager: own cities only).
    `stage=visit_scheduled` is rejected — that needs the per-row visit modal.
    """
    user = g.user
    body = request.get_json(silent=True) or {}
    oh_ids = body.get("oh_ids") or []
    updates = body.get("updates") or {}

    if not isinstance(oh_ids, list) or not oh_ids:
        return jsonify({"error": "oh_ids must be a non-empty array"}), 400
    if not isinstance(updates, dict) or not updates:
        return jsonify({"error": "updates must be a non-empty object"}), 400

    bad = [k for k in updates if k not in BULK_ALLOWED_FIELDS]
    if bad:
        return jsonify({"error": f"fields not allowed in bulk update: {bad}"}), 400

    if "priority" in updates:
        if user["role"] not in PRIORITY_ROLES:
            return jsonify({"error": "only admin/manager can change priority"}), 403
        updates["priority"] = bool(updates["priority"])

    stage = updates.get("stage")
    if stage is not None and stage not in VALID_STAGES:
        return jsonify({"error": f"invalid stage: {stage}"}), 400
    if stage == "visit_scheduled":
        return jsonify({"error": "visit_scheduled requires the per-row schedule modal"}), 400
    if stage == "rejected" and not updates.get("stage_reason"):
        return jsonify({"error": "stage_reason required when stage=rejected"}), 400
    stage_reason = updates.get("stage_reason")
    if stage_reason and stage_reason not in VALID_REJECT_REASONS:
        return jsonify({"error": f"invalid stage_reason: {stage_reason}"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT oh_id, city, stage, assigned_rm_ids, follow_up_at, stage_reason, "
                "assigned_mgr_id, priority "
                "FROM inventory WHERE oh_id = ANY(%s) FOR UPDATE",
                (oh_ids,),
            )
            existing = {r["oh_id"]: r for r in cur.fetchall()}

            not_found = [oid for oid in oh_ids if oid not in existing]
            forbidden: list[str] = []
            allowed_ids: list[str] = []
            for oid, row in existing.items():
                if user["role"] == "rm" and user["id"] not in (row.get("assigned_rm_ids") or []):
                    forbidden.append(oid); continue
                if user["role"] == "manager" and row["city"] not in _expand_cities(user.get("cities") or []):
                    forbidden.append(oid); continue
                allowed_ids.append(oid)

            updated_count = 0
            if allowed_ids:
                set_parts = []
                params: list = []
                for k, v in updates.items():
                    set_parts.append(f"{k} = %s")
                    params.append(v)
                params.append(allowed_ids)
                cur.execute(
                    f"UPDATE inventory SET {', '.join(set_parts)} WHERE oh_id = ANY(%s)",
                    params,
                )
                updated_count = cur.rowcount

                # One activity_log row per (entity, field changed), written in a
                # single batched INSERT — a per-row loop of INSERTs blows the
                # request timeout on large selections.
                log_rows = []
                for oid in allowed_ids:
                    before = existing[oid]
                    for k, v in updates.items():
                        # Same value re-submitted: skip everything except `stage`.
                        # Re-applying the current stage in bulk is a deliberate
                        # re-touch and logs a bulk_stage_change (counts as an
                        # action) even though the column is unchanged.
                        same = before.get(k) == v
                        if same and k != "stage":
                            continue
                        meta = {"bulk_batch_size": len(allowed_ids)}
                        if same and k == "stage":
                            meta["same_stage"] = True
                        log_rows.append({
                            "actor_user_id": user["id"], "actor_email": user["email"],
                            "entity_type": "inventory", "entity_id": oid,
                            "action": ("bulk_stage_change" if k == "stage" else "bulk_update"),
                            "field": k, "before_value": before.get(k), "after_value": v,
                            "metadata": meta,
                        })
                log_many(cur, log_rows)

        return jsonify({
            "requested": len(oh_ids),
            "updated": updated_count,
            "skipped_forbidden": forbidden,
            "not_found": not_found,
        })
    finally:
        conn.close()
