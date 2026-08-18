"""Live Calls (Phase 5) — the RM-facing side of the auto-dialer.

The dialer rings an RM's handset and bridges the lead; the webhook (or the poll
fallback) flips the dial_queue row to 'done'. This blueprint lets the RM see who's on
the line right now and, after each call, mark whether they actually reached the person —
which is the only thing that drives miss_count / ever_connected and the follow-up state.

No SSE, no Redis: the page polls /my-calls every few seconds and observes each dial_queue
transition on the next tick (see the "Live Calls polls dial_queue" notes in
services/dialer.py and api/bonvoice.py).

Model mapping: lead = inventory row keyed by oh_id; phone = seller_phone; the call the
RM dispositions is a dial_queue row (its id is the disposition target).
"""
from __future__ import annotations

import json
import logging
import math
import uuid as _uuid
from datetime import datetime, time, timedelta, timezone

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from ..services.dialer import IST, _in_window

log = logging.getLogger("live_calls")
bp = Blueprint("live_calls", __name__, url_prefix="/api/live-calls")
from .auth import require_auth  # noqa: E402

# reason label → follow-up delay in minutes; None = an outright reject (invalid number).
# The label IS the value the client POSTs, so it doubles as the reject_reason on record.
MISS_REASONS = {
    "Did Not Pick / Not Reachable": 180,   # +3h
    "Switched Off": 360,                    # +6h
    "Invalid Number": None,                 # → Rejected, no follow-up
}
# Stages the dialer's intake flow may move a lead out of. A missed/answered call must
# never drag a qualified / visit / supply-closure lead backwards, so only these convert.
_INTAKE_STAGES = ("lead", "active", "call_not_received", "follow_up")
RNR_THRESHOLD = 10  # consecutive misses on a never-connected lead → auto-reject


# ── the snapshot the page polls ──────────────────────────────────────────────

@bp.get("/my-calls")
@require_auth()
def my_calls():
    """Everything the RM's Live Calls page renders, scoped to g.user by email. One
    endpoint = one source of truth (there's no second SSE path to keep in sync)."""
    email = g.user["email"]
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # Step 1 — my running campaign whose calling window is open right now.
            cur.execute(
                "SELECT id::text AS id, name, strategy, window_start, window_end "
                "  FROM dial_campaigns "
                " WHERE status = 'running' "
                "   AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(rms) e "
                "                WHERE lower(e) = lower(%(email)s)) "
                " ORDER BY created_at DESC", {"email": email})
            campaign = next((c for c in cur.fetchall()
                             if _in_window(c["window_start"], c["window_end"])), None)

            now_calling, upcoming = None, []
            if campaign:
                cid = campaign["id"]
                # Step 2 — the lead ringing this RM now.
                cur.execute(
                    "SELECT q.id::text AS id, q.oh_id, q.dialed_at, q.attempts, "
                    "       l.seller_name AS name, l.seller_phone AS phone, l.society, l.city, "
                    "       l.bedrooms AS configuration, l.price AS budget, "
                    "       l.stage, l.miss_count, l.ever_connected "
                    "  FROM dial_queue q JOIN inventory l ON l.oh_id = q.oh_id "
                    " WHERE q.campaign_id = %(cid)s AND q.status = 'dialing' "
                    "   AND lower(q.rm_email) = lower(%(email)s) "
                    " ORDER BY q.dialed_at DESC LIMIT 1", {"cid": cid, "email": email})
                now_calling = cur.fetchone()

                # Step 3 — the queue ahead. round_robin/least_load share the pending pool
                # (rm_email is NULL until claimed); 'assigned' shows only this RM's leads.
                mine = "AND lower(q.rm_email) = lower(%(email)s)" if campaign["strategy"] == "assigned" else ""
                cur.execute(
                    f"SELECT q.id::text AS id, q.oh_id, q.position, "
                    f"       l.seller_name AS name, l.society, l.city, "
                    f"       l.bedrooms AS configuration, l.price AS budget, l.stage "
                    f"  FROM dial_queue q JOIN inventory l ON l.oh_id = q.oh_id "
                    f" WHERE q.campaign_id = %(cid)s AND q.status = 'pending' {mine} "
                    f" ORDER BY q.position, q.id LIMIT 25", {"cid": cid, "email": email})
                upcoming = cur.fetchall()

            # Step 4 — today's calls (IST day), NOT campaign-scoped so a finished
            # campaign's unmarked calls stay reachable.
            cur.execute(
                "SELECT q.id::text AS id, q.oh_id, q.dialed_at, q.ended_at, q.answered, "
                "       q.outcome, q.attempts, q.call_result, q.call_result_at, "
                "       l.seller_name AS name, l.seller_phone AS phone, l.society, l.city, l.stage, "
                # will the dialer ring this lead again? mirrors the requeue rule (unanswered
                # + attempts left). false → the call is final → offer a status change.
                "       (NOT q.answered AND q.attempts < COALESCE(c.max_attempts, 1)) AS retries_left "
                "  FROM dial_queue q JOIN inventory l ON l.oh_id = q.oh_id "
                "  LEFT JOIN dial_campaigns c ON c.id = q.campaign_id "
                " WHERE lower(q.rm_email) = lower(%(email)s) AND q.dialed_at IS NOT NULL "
                "   AND (q.dialed_at AT TIME ZONE 'Asia/Kolkata')::date "
                "     = (now()       AT TIME ZONE 'Asia/Kolkata')::date "
                " ORDER BY q.dialed_at DESC LIMIT 100", {"email": email})
            completed = cur.fetchall()
    finally:
        conn.close()

    return jsonify({
        "campaign": campaign,
        "upcoming_is_shared": bool(campaign) and campaign["strategy"] != "assigned",
        "now_calling": now_calling,
        "upcoming": upcoming,
        "completed": completed,
    })


@bp.get("/unmarked-count")
@require_auth()
def unmarked_count():
    """The nav badge: my dialer calls today still waiting for a result."""
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) AS n FROM dial_queue "
                " WHERE lower(rm_email) = lower(%(email)s) AND dialed_at IS NOT NULL "
                "   AND call_result IS NULL "
                "   AND (dialed_at AT TIME ZONE 'Asia/Kolkata')::date "
                "     = (now()      AT TIME ZONE 'Asia/Kolkata')::date",
                {"email": g.user["email"]})
            n = cur.fetchone()["n"]
    finally:
        conn.close()
    return jsonify({"count": int(n or 0)})


# ── marking a call's result ──────────────────────────────────────────────────

def _followup_date(minutes):
    """When to call back, as an IST date. The +3h/+6h nudge is clamped into calling
    hours (10:00–19:00 IST); anything landing after close rolls to the next morning.
    follow_up_at is a DATE column, so only the resulting day is stored."""
    target = datetime.now(IST) + timedelta(minutes=minutes)
    if target.time() > time(19, 0):
        target = (target + timedelta(days=1)).replace(hour=10, minute=0)
    elif target.time() < time(10, 0):
        target = target.replace(hour=10, minute=0)
    return target.date()


def _note_entry(body):
    """One note in inventory.note_thread's shape (matches inventory/records.py)."""
    return {
        "id": str(_uuid.uuid4()),
        "author_id": g.user["id"],
        "author_name": g.user.get("name"),
        "author_email": g.user["email"],
        "body": body,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": "call",
    }


@bp.post("/leads/<oh_id>/result")
@require_auth()
def mark_result(oh_id):
    """Log a call's outcome. Connected resets the miss streak and latches ever_connected;
    a miss increments it, sets a follow-up, and (past the RNR threshold on a never-reached
    lead, or an invalid number) rejects. A validated dialer queue_item waives the 2h
    anti-spam cooldown."""
    body = request.get_json(silent=True) or {}
    connected = bool(body.get("connected"))
    queue_item_id = body.get("queue_item_id") or None
    email = g.user["email"]

    # Every disposition is for a real dialer call the RM owns — the owned queue row IS
    # the authorization, so it is mandatory. Without it there is nothing to scope the
    # write to, which would let any RM disposition any lead by oh_id.
    if not queue_item_id:
        return jsonify({"error": "queue_item_id is required"}), 422

    # Validate the miss payload BEFORE touching the DB, so a bad request records nothing
    # (and can't stamp the queue row done without an actual disposition).
    reason = notes = due_date = None
    reject = False
    if not connected:
        reason = body.get("reason")
        notes = (body.get("notes") or "").strip()
        if reason not in MISS_REASONS:
            return jsonify({"error": "pick a reason for the miss"}), 422
        # notes are optional — the reason already drives the follow-up/reject logic
        reject = MISS_REASONS[reason] is None
        due_date = None if reject else _followup_date(MISS_REASONS[reason])

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # Ownership + idempotency: the call must be a dialer row dialed to THIS RM
            # that isn't marked yet. The only authorization barrier, so never optional;
            # `call_result IS NULL` stops a double-submit double-counting the miss.
            cur.execute(
                "SELECT id FROM dial_queue WHERE id::text = %(qid)s AND oh_id = %(oh)s "
                "  AND lower(rm_email) = lower(%(email)s) AND call_result IS NULL",
                {"qid": queue_item_id, "oh": oh_id, "email": email})
            if cur.fetchone() is None:
                return jsonify({"error": "that call isn't yours to mark, or it's already marked"}), 403

            if connected:
                cur.execute(
                    "UPDATE inventory SET ever_connected = true, miss_count = 0, "
                    "  stage = CASE WHEN stage IN ('lead','active','call_not_received') "
                    "               THEN 'follow_up' ELSE stage END "
                    " WHERE oh_id = %(oh)s RETURNING oh_id", {"oh": oh_id})
                if cur.fetchone() is None:
                    return jsonify({"error": "lead not found"}), 404
                result = {"status": "ok", "connected": True, "miss_count": 0}
                blocked = False
            else:
                note_body = f"Call attempt — {reason}." + (f" {notes}" if notes else "")
                note_json = json.dumps([_note_entry(note_body)])
                # One statement applies miss_count / stage / follow-up / reject / note
                # atomically. A dialer retry is a legitimate repeat call, so the 2h
                # anti-spam cooldown is waived (skip=true); ownership already gates it.
                cur.execute(
                "WITH cur AS ("
                "  SELECT oh_id, last_no_timestamp AS prev,"
                "         (NOT %(skip)s AND last_no_timestamp IS NOT NULL"
                "          AND last_no_timestamp > now() - interval '2 hours') AS blocked"
                "    FROM inventory WHERE oh_id = %(oh)s) "
                "UPDATE inventory l SET "
                "  miss_count = CASE WHEN cur.blocked OR %(reject)s THEN l.miss_count "
                "                    ELSE l.miss_count + 1 END, "
                "  stage = CASE "
                "            WHEN cur.blocked THEN l.stage "
                "            WHEN %(reject)s THEN 'rejected' "
                "            WHEN NOT l.ever_connected AND l.miss_count + 1 >= %(rnr)s THEN 'rejected' "
                "            WHEN l.stage IN ('lead','active','call_not_received','follow_up') "
                "                 THEN CASE WHEN NOT l.ever_connected THEN 'call_not_received' ELSE 'follow_up' END "
                "            ELSE l.stage END, "
                # follow_up_at is a never-NULL DATE; on reject/RNR leave it as-is (a
                # rejected lead is out of the follow-up lists anyway) rather than blank it.
                "  follow_up_at = CASE "
                "            WHEN cur.blocked OR %(reject)s THEN l.follow_up_at "
                "            WHEN NOT l.ever_connected AND l.miss_count + 1 >= %(rnr)s THEN l.follow_up_at "
                "            ELSE %(due)s::date END, "
                "  reject_reason = CASE "
                "            WHEN NOT cur.blocked AND %(reject)s THEN %(reason)s "
                "            WHEN NOT cur.blocked AND NOT l.ever_connected AND l.miss_count + 1 >= %(rnr)s "
                "                 THEN 'RNR — 10 missed calls' "
                "            ELSE l.reject_reason END, "
                "  note_thread = CASE WHEN cur.blocked THEN l.note_thread "
                "                     ELSE l.note_thread || %(note)s::jsonb END, "
                "  last_no_timestamp = CASE WHEN cur.blocked THEN l.last_no_timestamp ELSE now() END "
                "FROM cur WHERE l.oh_id = cur.oh_id "
                "RETURNING l.miss_count, l.stage, l.ever_connected, cur.blocked, "
                "          cur.prev + interval '2 hours' AS retry_at",
                    {"skip": True, "oh": oh_id, "reject": reject, "rnr": RNR_THRESHOLD,
                     "due": due_date, "reason": reason, "note": note_json})
                row = cur.fetchone()
                if row is None:
                    return jsonify({"error": "lead not found"}), 404
                blocked = row["blocked"]
                if blocked:  # defensive: skip=True can't block, but never stamp if it did
                    mins = max(1, math.ceil((row["retry_at"] - datetime.now(timezone.utc)).total_seconds() / 60))
                    result = {"status": "blocked", "retry_in_minutes": mins}
                else:
                    moved_to_rnr = row["stage"] == "rejected" and not reject and row["miss_count"] >= RNR_THRESHOLD
                    result = {
                        "status": "ok", "connected": False,
                        "rejected": reject, "moved_to_rnr": moved_to_rnr,
                        "miss_count": row["miss_count"],
                        "follow_up_at": None if (reject or moved_to_rnr) else (due_date.isoformat() if due_date else None),
                    }

            # Stamp the queue row LAST — only after the disposition actually recorded —
            # so a 404 (or, defensively, a blocked path) leaves the call still unmarked.
            if not blocked:
                cur.execute(
                    "UPDATE dial_queue SET call_result = %(r)s, call_result_at = now(), "
                    "  call_result_by = %(email)s WHERE id::text = %(qid)s",
                    {"r": "connected" if connected else "missed", "qid": queue_item_id, "email": email})
    except Exception as e:  # noqa: BLE001 — surface the real cause instead of a bare 500
        log.exception("live-calls: mark_result failed for oh_id=%s", oh_id)
        return jsonify({"error": f"could not save the call result: {str(e)[:200]}"}), 500
    finally:
        conn.close()
    return jsonify(result)
