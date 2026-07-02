"""Supply Closure Tracker sync.

One-way pull: mirror PROPERTIES_DB.cp_inventory_status → inventory. For rows
with valid_direct_id, copy direct_stage → inventory.stage and supply_status →
inventory.stage_reason (both slugified), matching inventory.oh_id = cp_id.

Shared by POST /api/inventory/supply-sync (page/manual) and the Render cron
(scripts/run_supply_sync.py). Pass an actor to log a supply_sync 'run' row; the
cron omits it to avoid flooding the activity log every few minutes.
"""
from __future__ import annotations

import logging
import re

from psycopg2.extras import execute_values

from ..db import get_conn, get_props_conn
from .activity import log as log_activity

log = logging.getLogger(__name__)


def _slug(s) -> str:
    """Normalise a free-text label to a snake_case key.
    'Token to AMA' -> 'token_to_ama'; 'Dead - Sold' -> 'dead_sold'.
    """
    return re.sub(r"[^a-z0-9]+", "_", (str(s or "")).strip().lower()).strip("_")


def run_supply_sync(actor_user_id: int | None = None, actor_email: str | None = None) -> dict:
    """Read cp_inventory_status and mirror into inventory. Returns
    {source_rows, matched, updated}. Raises on DB failure (callers decide how to
    surface it). Logs a supply_sync 'run' only when actor_email is given."""
    pconn = get_props_conn()
    try:
        with pconn, pconn.cursor() as pcur:
            pcur.execute(
                "SELECT cp_id, direct_stage, supply_status, visit_scheduled_date "
                "FROM cp_inventory_status "
                "WHERE valid_direct_id IS TRUE AND cp_id IS NOT NULL AND cp_id <> ''"
            )
            rows = pcur.fetchall()
    finally:
        pconn.close()

    pairs = []
    for r in rows:
        oh = str(r.get("cp_id")).strip()
        stage = _slug(r.get("direct_stage"))
        reason = _slug(r.get("supply_status")) or None
        # No post-visit progress yet but a visit IS booked in the tracker →
        # reflect that as the 'visit_scheduled' stage on the lead.
        if not stage and (str(r.get("visit_scheduled_date") or "").strip()):
            stage = "visit_scheduled"
            reason = None
        if oh and stage:
            pairs.append((oh, stage, reason))
    if not pairs:
        return {"source_rows": len(rows), "matched": 0, "updated": 0}

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
            if actor_email is not None:
                log_activity(
                    cur, actor_user_id=actor_user_id, actor_email=actor_email,
                    entity_type="supply_sync", entity_id=None, action="run",
                    metadata={"source_rows": len(rows), "matched": len(pairs), "updated": updated},
                )
        return {"source_rows": len(rows), "matched": len(pairs), "updated": updated}
    finally:
        conn.close()
