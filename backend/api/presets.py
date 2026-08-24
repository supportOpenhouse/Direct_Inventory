"""Per-user saved filter presets for the Home board (see migrations/044).

The DB stores three fixed slot columns (preset1/2/3), but the API speaks a
slot-indexed ARRAY so the frontend can stay generic (mirrors CP-Inventory-Portal):

    { presets: [slot1, slot2, slot3],   # each {name, filters} or null
      sequence: [n, n, n],              # left-to-right display order of slots
      priority: n | null }              # auto-applying slot; must equal sequence[0]

GET → this user's document (or an empty one). PUT → replace it whole. The DB
CHECK (filter_presets_priority_first) enforces priority == sequence[0].
"""
from __future__ import annotations

import json

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from .auth import require_auth

bp = Blueprint("presets", __name__, url_prefix="/api/presets")

SLOTS = [1, 2, 3]


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
        if not row:
            return jsonify({"presets": [None, None, None], "sequence": SLOTS, "priority": None})
        # psycopg2 returns JSONB columns already parsed to dicts.
        return jsonify({
            "presets": [row["preset1"], row["preset2"], row["preset3"]],
            "sequence": [int(n) for n in (row["sequence"] or SLOTS)],
            "priority": row["priority"],
        })
    finally:
        conn.close()


@bp.put("")
@require_auth()
def save_presets():
    body = request.get_json(silent=True) or {}
    presets = body.get("presets")
    if not isinstance(presets, list) or len(presets) != 3:
        return jsonify({"error": "presets must be a list of exactly 3 (null for empty slots)"}), 400
    sequence = body.get("sequence") or list(SLOTS)
    if sorted(sequence) != SLOTS:
        return jsonify({"error": "sequence must be a permutation of [1, 2, 3]"}), 400
    priority = body.get("priority")
    if priority is not None and sequence[0] != priority:
        return jsonify({"error": "priority must be the first slot in sequence"}), 400

    def js(v):
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
                (g.user["id"], js(presets[0]), js(presets[1]), js(presets[2]), sequence, priority),
            )
        return jsonify({"ok": True})
    finally:
        conn.close()
