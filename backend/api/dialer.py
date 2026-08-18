"""Auto-dialer campaigns — build a queue from a rule tree, then let the background worker
work it. Admin-only: a campaign rings other people's phones.

The dialling itself lives in services/dialer.py; this is the control surface.
"""
from __future__ import annotations

import logging

from flask import Blueprint, g, jsonify, request
from psycopg2.extras import Json

from ..db import get_conn
from ..services.dialer import (
    FIELDS, OPS, UNOWNED_DETAIL, assign_owners, compile_rules, count_matching,
    materialize, window_has_passed, windows_overlap,
)

log = logging.getLogger("dialer")
bp = Blueprint("dialer", __name__, url_prefix="/api/dialer")
from .auth import require_auth  # noqa: E402  (kept next to bp for readability)

STRATEGIES = ("assigned", "round_robin", "least_load")
# multi-select fields whose options come from what's actually in inventory
_OPTION_COLUMNS = {"society": "society", "city": "city", "source": "source", "stage": "stage"}
# Who a campaign may dial. Calling role only: the pool does the calling, and click-to-call
# rings their own handset. Admins run campaigns; they aren't dialled by them.
_CALLABLE_RMS = ("SELECT id, email, name, phone, role FROM users "
                 " WHERE is_active AND role = 'rm' ORDER BY name NULLS LAST, email")


class _Refuse(Exception):
    """A campaign that can't run — carries the HTTP status the API should return."""
    def __init__(self, message, status):
        super().__init__(message)
        self.message = message
        self.status = status


def _window_not_over(ws, we):
    if window_has_passed(ws, we):
        raise _Refuse(f"that calling window ({ws}–{we} IST) has already ended today — "
                      f"nothing would be dialled until tomorrow. Widen the window or save "
                      f"it as a draft and start it in the morning.", 422)


def _assert_no_rm_conflict(cur, rms, ws, we, exclude_id=None):
    """Refuse a campaign that shares an RM, at overlapping hours, with a running one:
    _tick_campaign counts live calls per campaign, so two would each judge the same RM
    idle and ring their handset twice at once."""
    cur.execute("SELECT id, name, rms, window_start, window_end FROM dial_campaigns "
                "WHERE status = 'running'")
    wanted = {e.lower() for e in rms}
    for r in cur.fetchall():
        if exclude_id is not None and str(r["id"]) == str(exclude_id):
            continue
        shared = sorted(wanted & {str(e).lower() for e in (r["rms"] or [])})
        if not shared:
            continue
        if windows_overlap(ws, we, r["window_start"], r["window_end"]):
            raise _Refuse(
                f"{shared[0]} is already dialling on '{r['name']}' "
                f"({r['window_start']}–{r['window_end']}). Pause that campaign, drop that "
                f"RM, or pick a calling window that doesn't overlap.", 409)


@bp.get("/fields")
@require_auth("admin")
def dialer_fields():
    """The condition builder's vocabulary — the same whitelist the compiler enforces,
    plus the distinct values currently present for each multi-select field."""
    options = {}
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            for key, col in _OPTION_COLUMNS.items():
                cur.execute(f"SELECT DISTINCT {col} AS v FROM inventory "
                            f"WHERE {col} IS NOT NULL AND btrim({col}) <> '' ORDER BY 1 LIMIT 300")
                options[key] = [r["v"] for r in cur.fetchall()]
            cur.execute(_CALLABLE_RMS)
            rms = cur.fetchall()
    finally:
        conn.close()
    return jsonify({
        "fields": [
            {"key": k, "label": v["label"], "kind": v["kind"],
             "ops": sorted(OPS[v["kind"]]), "options": options.get(k, [])}
            for k, v in FIELDS.items()
        ],
        "rms": [
            {"email": r["email"], "name": r["name"] or r["email"],
             "has_phone": bool(r["phone"]), "role": r["role"]}
            for r in rms
        ],
    })


@bp.post("/preview")
@require_auth("admin")
def dialer_preview():
    """Live match count for the rule tree. Under 'assigned' it counts only what the
    chosen RMs actually own — the real number of calls the campaign will place."""
    body = request.get_json(silent=True) or {}
    rules = body.get("rules") or {}
    strategy = body.get("strategy") or "round_robin"
    rms = body.get("rms") or []
    owner_ids = []
    if strategy == "assigned" and rms:
        wanted = {e.lower() for e in rms}
        conn = get_conn()
        try:
            with conn, conn.cursor() as cur:
                cur.execute(_CALLABLE_RMS)
                owner_ids = [u["id"] for u in cur.fetchall() if u["email"].lower() in wanted]
        finally:
            conn.close()
        if not owner_ids:
            return jsonify({"count": 0, "scoped": True})
    try:
        return jsonify({"count": count_matching(rules, owner_ids), "scoped": bool(owner_ids)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@bp.get("/campaigns")
@require_auth("admin")
def list_campaigns():
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                SELECT c.id, c.name, c.status, c.strategy, c.rms, c.created_at, c.started_at,
                       count(q.id) FILTER (WHERE q.status = 'pending')          AS pending,
                       count(q.id) FILTER (WHERE q.status = 'dialing')          AS live,
                       count(q.id) FILTER (WHERE q.status IN ('done','failed')) AS completed,
                       count(q.id)                                              AS total,
                       count(q.id) FILTER (
                           WHERE q.status <> 'skipped' OR q.detail IS DISTINCT FROM %(unowned)s
                       )                                                        AS targeted,
                       count(q.id) FILTER (WHERE q.attempts > 0)                AS unique_leads,
                       COALESCE(sum(q.attempts), 0)                             AS total_calls,
                       count(q.id) FILTER (WHERE q.answered)                    AS connected
                  FROM dial_campaigns c LEFT JOIN dial_queue q ON q.campaign_id = c.id
                 GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50
            """, {"unowned": UNOWNED_DETAIL})
            rows = cur.fetchall()
    finally:
        conn.close()
    return jsonify({"items": rows})


@bp.post("/campaigns")
@require_auth("admin")
def create_campaign():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    rules = body.get("rules") or {}
    rms = body.get("rms") or []
    strategy = body.get("strategy") or "round_robin"
    gap = int(body.get("gap_seconds") or 0)
    ws = body.get("window_start") or "10:00"
    we = body.get("window_end") or "19:00"
    attempts = int(body.get("max_attempts") or 1)
    cooldown = int(body.get("cooldown_minutes") or 180)
    start = bool(body.get("start", True))

    if not name:
        return jsonify({"error": "name is required"}), 400
    if strategy not in STRATEGIES:
        return jsonify({"error": f"unknown strategy {strategy!r}"}), 400
    if not rms:
        return jsonify({"error": "pick at least one RM to do the calling"}), 400
    try:
        compile_rules(rules)  # fail before we write anything
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # calling-role filter enforced here, not just in the picker — a hand-rolled
            # POST could otherwise queue calls to an admin's handset
            cur.execute(_CALLABLE_RMS)
            known = {u["email"].lower(): u for u in cur.fetchall()}
            unknown = [e for e in rms if e.lower() not in known]
            if unknown:
                return jsonify({"error": f"not an active RM: {unknown[0]}"}), 400
            if start:  # a draft dials nothing, so it can't conflict yet
                _window_not_over(ws, we)
                _assert_no_rm_conflict(cur, rms, ws, we)

            cur.execute("""
                INSERT INTO dial_campaigns
                       (name, rules, rms, strategy, gap_seconds, window_start, window_end,
                        max_attempts, cooldown_minutes, status, created_by, started_at)
                VALUES (%(name)s, %(rules)s, %(rms)s, %(strategy)s, %(gap)s, %(ws)s, %(we)s,
                        %(att)s, %(cool)s, %(status)s, %(by)s,
                        CASE WHEN %(status)s = 'running' THEN now() END)
                RETURNING id
            """, {"name": name, "rules": Json(rules), "rms": Json(rms), "strategy": strategy,
                  "gap": gap, "ws": ws, "we": we, "att": attempts, "cool": cooldown,
                  "status": "running" if start else "draft", "by": g.user["email"]})
            cid = cur.fetchone()["id"]
            queued = materialize(cur, cid, rules)
            unowned = 0
            if strategy == "assigned":
                pool = [(e, known[e.lower()]["id"]) for e in rms]
                unowned = assign_owners(cur, cid, pool)
    except _Refuse as e:
        return jsonify({"error": e.message}), e.status
    finally:
        conn.close()

    log.info("dialer: campaign %s created by %s — %d queued, %d unowned",
             cid, g.user["email"], queued - unowned, unowned)
    return jsonify({"id": str(cid), "queued": queued - unowned, "unowned": unowned}), 201


@bp.post("/campaigns/<campaign_id>/<action>")
@require_auth("admin")
def campaign_action(campaign_id, action):
    """start / pause / stop. Pausing places no new calls; whatever is ringing rings out.
    Stopping also drops the rest of the queue, so it can't be resumed."""
    status = {"start": "running", "pause": "paused", "stop": "done"}.get(action)
    if status is None:
        return jsonify({"error": f"unknown action {action!r}"}), 400
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            if status == "running":
                cur.execute("SELECT rms, window_start, window_end FROM dial_campaigns WHERE id = %s",
                            (campaign_id,))
                me = cur.fetchone()
                if me is None:
                    return jsonify({"error": "campaign not found"}), 404
                _window_not_over(me["window_start"], me["window_end"])
                _assert_no_rm_conflict(cur, [str(e) for e in (me["rms"] or [])],
                                       me["window_start"], me["window_end"], exclude_id=campaign_id)
            cur.execute(
                "UPDATE dial_campaigns SET status = %(status)s, "
                "  started_at = COALESCE(started_at, CASE WHEN %(status)s = 'running' THEN now() END) "
                " WHERE id = %(id)s RETURNING id",
                {"id": campaign_id, "status": status})
            if cur.fetchone() is None:
                return jsonify({"error": "campaign not found"}), 404
            if action == "stop":
                cur.execute("UPDATE dial_queue SET status = 'skipped' "
                            "WHERE campaign_id = %s AND status = 'pending'", (campaign_id,))
    except _Refuse as e:
        return jsonify({"error": e.message}), e.status
    finally:
        conn.close()
    return jsonify({"status": status})


@bp.get("/campaigns/<campaign_id>")
@require_auth("admin")
def campaign_detail(campaign_id):
    """Everything the live panel shows: counts, per-RM state, and the recent-calls feed."""
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM dial_campaigns WHERE id = %s", (campaign_id,))
            c = cur.fetchone()
            if c is None:
                return jsonify({"error": "campaign not found"}), 404
            cur.execute("""
                SELECT count(*) FILTER (WHERE status = 'pending')  AS pending,
                       count(*) FILTER (WHERE status = 'dialing')  AS live,
                       count(*) FILTER (WHERE status = 'done')     AS done,
                       count(*) FILTER (WHERE status = 'failed')   AS failed,
                       count(*) FILTER (WHERE status = 'skipped')  AS skipped,
                       count(*)                                    AS total,
                       count(*) FILTER (
                           WHERE status <> 'skipped' OR detail IS DISTINCT FROM %(unowned)s
                       )                                           AS targeted,
                       count(*) FILTER (WHERE attempts > 0)        AS unique_leads,
                       COALESCE(sum(attempts), 0)                  AS total_calls,
                       count(*) FILTER (WHERE answered)            AS connected
                  FROM dial_queue WHERE campaign_id = %(id)s
            """, {"id": campaign_id, "unowned": UNOWNED_DETAIL})
            stats = cur.fetchone()
            cur.execute("""
                SELECT q.rm_email,
                       count(*) FILTER (WHERE q.status = 'dialing')          AS live,
                       count(*) FILTER (WHERE q.status IN ('done','failed')) AS done
                  FROM dial_queue q WHERE q.campaign_id = %s AND q.rm_email IS NOT NULL
                 GROUP BY q.rm_email""", (campaign_id,))
            per_rm = cur.fetchall()
            cur.execute("""
                SELECT q.status, q.outcome, q.detail, q.rm_email, q.dialed_at, q.ended_at,
                       q.event_id, q.attempts, q.answered,
                       l.seller_name AS lead_name, l.society, l.oh_id
                  FROM dial_queue q JOIN inventory l ON l.oh_id = q.oh_id
                 WHERE q.campaign_id = %s AND q.dialed_at IS NOT NULL
                 ORDER BY q.dialed_at DESC LIMIT 25""", (campaign_id,))
            feed = cur.fetchall()
    finally:
        conn.close()
    return jsonify({
        "campaign": {k: (str(v) if k == "id" else v) for k, v in c.items()},
        "stats": stats or {},
        "per_rm": {r["rm_email"]: {"live": r["live"], "done": r["done"]} for r in per_rm},
        "feed": feed,
    })
