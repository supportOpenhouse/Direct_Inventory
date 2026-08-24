"""Per-user saved filter presets for the Home board (see migrations/044).

GET  /api/presets  → this user's preset row (or empty defaults).
PUT  /api/presets  → replace it. The frontend owns the slot bookkeeping; we just
                     store the columns. `priority` must be sequence[0] (DB CHECK).
"""
from __future__ import annotations

import json

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from .auth import require_auth

bp = Blueprint("presets", __name__, url_prefix="/api/presets")

_EMPTY = {"preset1": None, "preset2": None, "preset3": None, "sequence": [], "priority": None}


@bp.get("")
@require_auth()
def get_presets():
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT preset1, preset2, preset3, sequence, priority "
                "FROM filter_presets WHERE user_id = %s",
                (g.user["id"],),
            )
            row = cur.fetchone()
        # psycopg2 returns JSONB columns already parsed to dicts.
        return jsonify(row or dict(_EMPTY))
    finally:
        conn.close()


@bp.put("")
@require_auth()
def save_presets():
    body = request.get_json(silent=True) or {}
    sequence = body.get("sequence") or []
    priority = body.get("priority")

    # Minimal validation — the DB CHECK enforces priority == sequence[0].
    if not isinstance(sequence, list) or any(s not in (1, 2, 3) for s in sequence):
        return jsonify({"error": "sequence must be a list of slot numbers 1..3"}), 400
    if priority is not None and (not sequence or sequence[0] != priority):
        return jsonify({"error": "priority must be the first slot in sequence"}), 400

    def js(v):
        # Accept a {name, filters} dict per slot; store as JSONB (or NULL).
        return json.dumps(v) if isinstance(v, dict) and v.get("name") else None

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO filter_presets (user_id, preset1, preset2, preset3, sequence, priority, updated_at)
                VALUES (%s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    preset1 = EXCLUDED.preset1, preset2 = EXCLUDED.preset2, preset3 = EXCLUDED.preset3,
                    sequence = EXCLUDED.sequence, priority = EXCLUDED.priority, updated_at = NOW()
                """,
                (g.user["id"], js(body.get("preset1")), js(body.get("preset2")),
                 js(body.get("preset3")), sequence, priority),
            )
        return jsonify({"ok": True})
    finally:
        conn.close()
