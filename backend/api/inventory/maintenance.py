"""Background maintenance jobs: cp-match-scan, assign-missing, supply-sync."""
from __future__ import annotations

import logging

from flask import g, jsonify, request

from ...db import get_conn
from ...services.activity import log as log_activity
from ...services.assignment import assign_missing_batch
from ...services.cp_match import backfill_one_chunk
from ...services.supply_sync import run_supply_sync
from ..auth import require_auth
from ._common import bp

log = logging.getLogger(__name__)


@bp.post("/supply-sync")
@require_auth()
def supply_sync():
    """Sync the Supply Closure Tracker from PROPERTIES_DB.cp_inventory_status.
    Core logic lives in services.supply_sync (shared with the Render cron).

    Response: { source_rows, matched, updated }
    """
    try:
        result = run_supply_sync(actor_user_id=g.user["id"], actor_email=g.user["email"])
        return jsonify(result)
    except Exception as e:
        log.exception("supply-sync failed")
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 502


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
        # Cooldown for the manual missing-backfill (Track Tasks button): the heavy
        # scan can't be triggered more than once per 15 min — the cron already
        # runs it on that cadence. Fail-soft if job_runs isn't migrated yet.
        _COOLDOWN_S = 15 * 60
        if mode == "missing":
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT EXTRACT(EPOCH FROM (NOW() - last_run_at)) AS age "
                        "FROM job_runs WHERE job = 'assign_missing_manual'"
                    )
                    last = cur.fetchone()
                conn.commit()
            except Exception:
                conn.rollback()
                last = None
            if last and last.get("age") is not None and last["age"] < _COOLDOWN_S:
                wait_min = int((_COOLDOWN_S - last["age"]) // 60) + 1
                return jsonify({
                    "error": f"Auto-assign ran recently — try again in ~{wait_min} min.",
                    "cooldown": True,
                }), 429

        result = assign_missing_batch(conn, mode=mode)
        result["mode"] = mode

        if mode == "missing":
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO job_runs (job, last_run_at) "
                        "VALUES ('assign_missing_manual', NOW()) "
                        "ON CONFLICT (job) DO UPDATE SET last_run_at = NOW()"
                    )
                conn.commit()
            except Exception:
                conn.rollback()

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
