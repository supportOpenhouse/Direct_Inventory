"""Background maintenance jobs: cp-match-scan, assign-missing, supply-sync."""
from __future__ import annotations

import logging
import re

from flask import g, jsonify, request
from psycopg2.extras import execute_values

from ...db import get_conn, get_props_conn
from ...services.activity import log as log_activity
from ...services.assignment import assign_missing_batch
from ...services.cp_match import backfill_one_chunk
from ..auth import require_auth
from ._common import bp

log = logging.getLogger(__name__)


def _slug(s) -> str:
    """Normalise a free-text label to a snake_case key.
    'Token to AMA' -> 'token_to_ama'; 'Dead - Sold' -> 'dead_sold'.
    """
    return re.sub(r"[^a-z0-9]+", "_", (str(s or "")).strip().lower()).strip("_")


@bp.post("/supply-sync")
@require_auth()
def supply_sync():
    """Sync the Supply Closure Tracker from PROPERTIES_DB.cp_inventory_status.

    For rows where valid_direct_id is true, copy direct_stage → inventory.stage
    and supply_status → inventory.stage_reason (both slugified), matching
    inventory.oh_id = cp_inventory_status.cp_id.

    Response: { source_rows, matched, updated }
    """
    pconn = get_props_conn()
    try:
        with pconn, pconn.cursor() as pcur:
            pcur.execute(
                "SELECT cp_id, direct_stage, supply_status FROM cp_inventory_status "
                "WHERE valid_direct_id IS TRUE AND cp_id IS NOT NULL AND cp_id <> ''"
            )
            rows = pcur.fetchall()
    except Exception as e:
        log.exception("supply-sync: reading cp_inventory_status failed")
        return jsonify({"error": f"properties DB read failed: {type(e).__name__}: {e}"}), 502
    finally:
        pconn.close()

    pairs = []
    for r in rows:
        oh = str(r.get("cp_id")).strip()
        stage = _slug(r.get("direct_stage"))
        reason = _slug(r.get("supply_status")) or None
        if oh and stage:
            pairs.append((oh, stage, reason))
    if not pairs:
        return jsonify({"source_rows": len(rows), "matched": 0, "updated": 0})

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "CREATE TEMP TABLE _supply (oh_id TEXT PRIMARY KEY, stage TEXT, stage_reason TEXT) "
                "ON COMMIT DROP"
            )
            execute_values(
                cur,
                "INSERT INTO _supply (oh_id, stage, stage_reason) VALUES %s "
                "ON CONFLICT (oh_id) DO UPDATE SET stage = EXCLUDED.stage, stage_reason = EXCLUDED.stage_reason",
                pairs,
            )
            cur.execute(
                "UPDATE inventory i SET stage = s.stage, stage_reason = s.stage_reason, updated_at = NOW() "
                "FROM _supply s WHERE i.oh_id = s.oh_id"
            )
            updated = cur.rowcount
            log_activity(
                cur, actor_user_id=g.user["id"], actor_email=g.user["email"],
                entity_type="supply_sync", entity_id=None, action="run",
                metadata={"source_rows": len(rows), "matched": len(pairs), "updated": updated},
            )
        return jsonify({"source_rows": len(rows), "matched": len(pairs), "updated": updated})
    except Exception as e:
        log.exception("supply-sync: updating inventory failed")
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    finally:
        conn.close()


@bp.post("/cp-match-scan")
@require_auth("admin", "manager", "rm")
def cp_match_scan():
    """Chunked scan: process ONE batch starting after `cursor` (oh_id).

    Frontend loops, passing back `next_cursor` from the previous response and
    accumulating totals in `prior_totals`, until the response has `done: true`.

    Request:  { cursor?: string, prior_totals?: {perfect, partial, no_match} }
    Response: { done, next_cursor, perfect, partial, no_match, processed }
    """
    body = request.get_json(silent=True) or {}
    cursor = body.get("cursor") or ""
    prior = body.get("prior_totals") or {}

    conn = get_conn()
    try:
        chunk = backfill_one_chunk(conn, cursor)
        if chunk["done"]:
            cumulative = {
                "perfect": int(prior.get("perfect") or 0) + chunk["perfect"],
                "partial": int(prior.get("partial") or 0) + chunk["partial"],
                "no_match": int(prior.get("no_match") or 0) + chunk["no_match"],
            }
            cumulative["total"] = cumulative["perfect"] + cumulative["partial"] + cumulative["no_match"]
            with conn, conn.cursor() as cur:
                log_activity(
                    cur,
                    actor_user_id=g.user["id"],
                    actor_email=g.user["email"],
                    entity_type="cp_match_scan",
                    entity_id=None,
                    action="run",
                    metadata=cumulative,
                )
        return jsonify(chunk)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        log.exception("cp_match scan failed (cursor=%r)", cursor)
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    finally:
        conn.close()


@bp.post("/assign-missing")
@require_auth()
def assign_missing():
    """Background POC backfill — kicked off after the board first paints on
    every page load. Walks the next chunk of rows whose `assigned_rm_ids` is
    empty and assigns POCs by society → micro_market → city.

    Body (optional):
      { "mode": "missing" }  — default; only touches empty assignments.
      { "mode": "all" }      — admin: re-evaluates EVERY row, overwriting any
                               existing assignment when the scope rules now
                               match a different RM. Powers the Users page
                               "Reassign Leads" button.

    Response: { updated, scanned, remaining, mode }
    """
    body = request.get_json(silent=True) or {}
    mode = "all" if str(body.get("mode") or "").lower() == "all" else "missing"
    if mode == "all" and g.user["role"] != "admin":
        return jsonify({"error": "only admin can run mode=all"}), 403
    conn = get_conn()
    try:
        result = assign_missing_batch(conn, mode=mode)
        result["mode"] = mode
        if result.get("updated"):
            with conn, conn.cursor() as cur:
                log_activity(
                    cur,
                    actor_user_id=g.user["id"],
                    actor_email=g.user["email"],
                    entity_type="inventory",
                    entity_id=None,
                    action="assign_missing",
                    metadata=result,
                )
        return jsonify(result)
    except Exception as e:
        log.exception("assign_missing failed")
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
    finally:
        conn.close()
