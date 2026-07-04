"""Multi-row + admin assignment endpoints: bulk-update, assigned-rms."""
from __future__ import annotations

import json

from flask import g, jsonify, request

from ...db import get_conn
from ...services.activity import log as log_activity, log_many, bind_assigned_mgr
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
    # Dedup, then cap to a SINGLE RM — leads can't hold multiple RMs.
    seen = set()
    rm_ids = [x for x in rm_ids if not (x in seen or seen.add(x))][:1]

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

            # A reassign = the lead HAD an RM and is moving to a different one
            # (first-time assignment of an unassigned lead doesn't count). Flag it
            # + bump priority so the new RM sees it; the star color comes from the
            # actor's role (resolved at read time via reassigned_by_id).
            is_reassign = bool(before_ids) and bool(rm_ids) and set(before_ids) != set(rm_ids)
            # Admin-only endpoint → pink when it's a reassign.
            cur.execute(
                "UPDATE inventory SET "
                "  assigned_rm_ids = %s, "
                "  assigned_mgr_id = COALESCE(%s, assigned_mgr_id), "
                "  reassigned = CASE WHEN %s THEN TRUE ELSE reassigned END, "
                "  reassigned_by_id = CASE WHEN %s THEN %s ELSE reassigned_by_id END, "
                "  priority = CASE WHEN %s THEN TRUE ELSE priority END, "
                "  star_color = CASE WHEN %s THEN 'pink' ELSE star_color END "
                "WHERE oh_id = %s",
                (rm_ids, new_mgr, is_reassign, is_reassign, g.user["id"], is_reassign, is_reassign, oh_id),
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

    # A lead can hold at most one RM — cap the array.
    if "assigned_rm_ids" in updates:
        updates["assigned_rm_ids"] = (updates["assigned_rm_ids"] or [])[:1]

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

            # When the caller updates assigned_rm_ids and didn't also send an
            # explicit assigned_mgr_id, re-derive the manager from the new
            # first RM's `users.manager`. Without this, a reassignment from
            # Arti -> Aanchal would silently keep Arti's manager attached.
            if "assigned_rm_ids" in updates and "assigned_mgr_id" not in updates:
                new_rm_ids = updates["assigned_rm_ids"] or []
                if new_rm_ids:
                    cur.execute(
                        "SELECT manager FROM users WHERE id = %s",
                        (new_rm_ids[0],),
                    )
                    row = cur.fetchone()
                    updates["assigned_mgr_id"] = row["manager"] if row else None
                else:
                    # Empty array (RM cleared) -> mgr also cleared.
                    updates["assigned_mgr_id"] = None

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

                # Flag rows MOVED to a different RM (had an RM, set changed) so the
                # new RM sees them as priority. First-time assignment of an
                # unassigned lead doesn't count. Star color = actor's role.
                if "assigned_rm_ids" in updates:
                    new_set = set(updates["assigned_rm_ids"] or [])
                    reassigned_ids = [
                        oid for oid in allowed_ids
                        if new_set and (existing[oid].get("assigned_rm_ids") or [])
                        and set(existing[oid]["assigned_rm_ids"]) != new_set
                    ]
                    if reassigned_ids:
                        # Store the star color by actor role (admin → pink,
                        # manager → blue); rm reassign leaves star_color as-is.
                        reassign_color = {"admin": "pink", "manager": "blue"}.get(user["role"])
                        cur.execute(
                            "UPDATE inventory SET reassigned = TRUE, reassigned_by_id = %s, "
                            "priority = TRUE, star_color = COALESCE(%s, star_color) "
                            "WHERE oh_id = ANY(%s)",
                            (user["id"], reassign_color, reassigned_ids),
                        )

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
                # Fold each row's auto-derived manager change into its
                # assigned_rm_ids entry — one audit row per uid, not two.
                log_rows = bind_assigned_mgr(log_rows)
                log_many(cur, log_rows)

        return jsonify({
            "requested": len(oh_ids),
            "updated": updated_count,
            "skipped_forbidden": forbidden,
            "not_found": not_found,
        })
    finally:
        conn.close()
