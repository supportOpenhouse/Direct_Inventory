"""Push-based sheet sync.

The Apps Script (apps_script/sync_direct_inventory.gs) is the only thing that
should ever call POST /api/sync/sheet. It runs on a daily 11:30 IST trigger
and POSTs the full sheet contents:

  POST /api/sync/sheet
  X-Sync-Token: <SYNC_TOKEN>
  Content-Type: application/json
  { "rows": [ { "source": "...", "city": "...", ... }, ... ] }

Admin can also trigger by re-running the Apps Script's `runSync` function from
the script editor — no admin UI button (we don't have a way to fire Apps Script
remotely without yet more auth).
"""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from .. import config
from ..db import get_conn
from ..services.sheet_sync import run_push_sync
from .auth import require_auth

bp = Blueprint("sync", __name__, url_prefix="/api/sync")


@bp.post("/sheet")
def push_sync():
    token = request.headers.get("X-Sync-Token", "")
    if not config.SYNC_TOKEN or token != config.SYNC_TOKEN:
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    rows = body.get("rows")
    if not isinstance(rows, list):
        return jsonify({"error": "body must be {rows: [...]}"}), 400

    actor = body.get("actor") or "system:apps-script"

    conn = get_conn()
    try:
        summary = run_push_sync(conn, rows, actor_email=actor)
        return jsonify(summary)
    finally:
        conn.close()


@bp.get("/last")
@require_auth("admin", "manager")
def last_sync():
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """SELECT created_at, metadata FROM activity_log
                   WHERE entity_type = 'sync' AND action = 'sync_run'
                   ORDER BY created_at DESC LIMIT 1"""
            )
            row = cur.fetchone()
        return jsonify(row or {})
    finally:
        conn.close()
