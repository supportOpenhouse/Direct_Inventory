"""Push-based sheet sync.

The Apps Script (apps_script/sync_direct_inventory.gs) is the only thing that
should ever call POST /api/sync/sheet. It runs on a daily 11:30 IST trigger
and POSTs the full sheet contents:

  POST /api/sync/sheet
  X-Sync-Token: <SYNC_TOKEN>
  Content-Type: application/json
  { "rows": [ { "source": "...", "city": "...", ... }, ... ] }
"""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from .. import config
from ..db import get_conn
from ..services.oh_pricing_sync import run_pricing_sync
from ..services.sheet_sync import run_push_sync

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


@bp.post("/oh-pricing")
def push_pricing_sync():
    """OH Pricing push — replaces all rows for the given source_sheet.

    Body: { "source_sheet": "Gurgaon" | "Noida + GZB", "rows": [...] }
    """
    token = request.headers.get("X-Sync-Token", "")
    if not config.SYNC_TOKEN or token != config.SYNC_TOKEN:
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    rows = body.get("rows")
    source_sheet = (body.get("source_sheet") or "").strip()
    # Default True so a one-shot caller (e.g. curl) still gets a clean replace.
    # Multi-batch callers must set is_first_batch=False on batches 2..N.
    replace_existing = bool(body.get("is_first_batch", True))

    if not isinstance(rows, list):
        return jsonify({"error": "body must include rows: [...]"}), 400
    if source_sheet not in {"Gurgaon", "Noida + GZB"}:
        return jsonify({"error": "source_sheet must be 'Gurgaon' or 'Noida + GZB'"}), 400

    actor = body.get("actor") or "system:apps-script"

    conn = get_conn()
    try:
        summary = run_pricing_sync(
            conn, source_sheet, rows,
            replace_existing=replace_existing,
            actor_email=actor,
        )
        return jsonify(summary)
    finally:
        conn.close()
