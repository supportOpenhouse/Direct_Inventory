"""Auto-dialer — turn a campaign's rule tree into a queue, then keep every RM in the
pool on a call.

Two halves:
  * the **rule compiler** — the AND/OR tree the builder produces is untrusted input, so
    every field, operator and value goes through a whitelist and comes out as a bound
    parameter. Nothing from the client is ever interpolated into SQL.
  * the **tick** — runs every few seconds and, for each running campaign, dials the next
    lead for every RM who isn't already on a call. The Bonvoice hangup callback marks a
    slot done (see api/bonvoice.py _release_dial_slot), so "as soon as the previous call
    ends" is literally that: the callback frees the slot, the next tick fills it.

Sync psycopg2, no flask — so the Render background worker can import this module without
pulling in the web app. Model-mapped to inventory: lead → inventory row, lead.id → oh_id,
lead.phone → seller_phone, assignment → inventory.assigned_rm_ids (INT[] of users.id).
"""
from __future__ import annotations

import itertools
import logging
from datetime import datetime, time, timedelta, timezone
from time import monotonic

from .. import config
from ..db import get_conn
from . import bonvoice as bv

log = logging.getLogger("dialer")

TICK_SECONDS = 3
# a 'dialing' row with no hangup callback by now is assumed lost — otherwise one dropped
# webhook would wedge that RM for the rest of the campaign
STALE_AFTER_SECONDS = 420
# after this long with no callback, stop waiting and ask Bonvoice directly. Callbacks are
# the fast path; this is what makes the dialer advance without them.
POLL_AFTER_SECONDS = 20
POLL_EVERY_SECONDS = 15   # per call — the tick runs far more often than that
POLL_BATCH = 20
_polled: dict = {}        # event_id → monotonic() of last poll; process-local, self-pruning
IST = timezone(timedelta(hours=5, minutes=30))


# ── rule compiler ────────────────────────────────────────────────────────────

# field → (SQL expression over alias `l`=inventory, kind). The builder is driven by this
# same list via /api/dialer/fields, so the two can't drift.
FIELDS = {
    "society":        {"col": "l.society",        "kind": "multi",     "label": "Society"},
    "city":           {"col": "l.city",           "kind": "multi",     "label": "City"},
    "source":         {"col": "l.source",         "kind": "multi",     "label": "Lead source"},
    "stage":          {"col": "l.stage",          "kind": "multi",     "label": "Lead stage"},
    "created_at":     {"col": "l.created_at",     "kind": "daterange", "label": "Created date"},
    "miss_count":     {"col": "l.miss_count",     "kind": "number",    "label": "Missed calls"},
    "ever_connected": {"col": "l.ever_connected", "kind": "bool",      "label": "Ever connected"},
    # ponytail: no free-text `assigned_to` filter — assignment is inventory.assigned_rm_ids
    # (INT[]), and the RM pool + 'assigned' strategy already dial each RM's own leads.
    # Add a rm_multi field compiling to `assigned_rm_ids && ARRAY[...]` if anyone asks.
}
OPS = {
    "multi": {"IN", "NOT IN"},
    "daterange": {"BETWEEN"},
    "number": {"=", "<=", ">=", "<", ">"},
    "bool": {"IS"},
}
MAX_DEPTH = 4
MAX_VALUES = 200  # per IN list

# Never dialable, whatever the rules say: no number to ring.
BASE_PREDICATE = "l.seller_phone IS NOT NULL AND btrim(l.seller_phone) <> ''"


def compile_rules(node):
    """Rule tree → (SQL boolean expression over alias `l`, bound params dict).
    Raises ValueError on anything not in the whitelist. Empty condition → TRUE."""
    params = {}
    sql = _node(node, params, itertools.count(), 0)
    return sql, params


def _node(n, params, ctr, depth):
    if depth > MAX_DEPTH:
        raise ValueError("rule tree is nested too deep")
    if not isinstance(n, dict):
        raise ValueError("bad rule node")
    if n.get("type") != "group":
        return _condition(n, params, ctr)
    combinator = n.get("combinator", "AND")
    if combinator not in ("AND", "OR"):
        raise ValueError(f"bad combinator {combinator!r}")
    children = n.get("children") or []
    if not isinstance(children, list):
        raise ValueError("group children must be a list")
    if not children:
        return "TRUE"
    parts = [_node(c, params, ctr, depth + 1) for c in children]
    return "(" + f" {combinator} ".join(parts) + ")"


def _condition(n, params, ctr):
    field = FIELDS.get(n.get("field"))
    if field is None:
        raise ValueError(f"unknown field {n.get('field')!r}")
    op, kind, col = n.get("op"), field["kind"], field["col"]
    if op not in OPS[kind]:
        raise ValueError(f"operator {op!r} isn't allowed on {n.get('field')!r}")
    value = n.get("value")

    def bind(v):
        key = f"r{next(ctr)}"
        params[key] = v
        return f"%({key})s"

    if kind == "multi":
        if not isinstance(value, list):
            raise ValueError("a multi-select value must be a list")
        vals = [str(v) for v in value if v not in (None, "")][:MAX_VALUES]
        if not vals:
            return "TRUE"  # nothing selected = no filter, same as the live preview
        placeholders = ", ".join(bind(v) for v in vals)
        if op == "IN":
            return f"{col} IN ({placeholders})"
        return f"({col} IS NULL OR {col} NOT IN ({placeholders}))"

    if kind == "daterange":
        if not isinstance(value, list) or len(value) != 2:
            raise ValueError("a date range needs exactly two values")
        start, end = value
        if not start or not end:
            return "TRUE"
        return f"({col} >= {bind(str(start))}::date AND {col} < {bind(str(end))}::date + 1)"

    if kind == "number":
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise ValueError("a number condition needs a numeric value")
        return f"COALESCE({col}, 0) {op} {bind(num)}"

    return f"{col} IS {'TRUE' if bool(value) else 'NOT TRUE'}"


def count_matching(rules, owner_ids=None):
    """How many leads the rule tree selects now. `owner_ids` (users.id list) narrows to
    leads owned by a pool — under 'assigned' the rest are never dialled."""
    where, params = compile_rules(rules)
    owned = ""
    if owner_ids:
        owned = " AND l.assigned_rm_ids && %(owner_ids)s::int[]"
        params = {**params, "owner_ids": list(owner_ids)}
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"SELECT count(*) AS n FROM inventory l "
                        f"WHERE {BASE_PREDICATE} AND {where}{owned}", params)
            return int(cur.fetchone()["n"] or 0)
    finally:
        conn.close()


UNOWNED_DETAIL = "not assigned to anyone in this pool"


def assign_owners(cur, campaign_id, pool):
    """Strategy 'assigned': stamp each queued lead with an RM in the pool that owns it
    (inventory.assigned_rm_ids). `pool` = [(email, user_id), …]. Leads owned by nobody in
    the pool are skipped outright — a queue nobody may claim would never drain. Returns
    how many were skipped."""
    for email, uid in pool:
        if not uid:
            continue
        cur.execute(
            "UPDATE dial_queue q SET rm_email = %(rm)s "
            "  FROM inventory l "
            " WHERE l.oh_id = q.oh_id AND q.campaign_id = %(cid)s "
            "   AND q.rm_email IS NULL AND %(uid)s = ANY(l.assigned_rm_ids)",
            {"cid": campaign_id, "rm": email, "uid": uid})
    cur.execute(
        "UPDATE dial_queue SET status = 'skipped', detail = %(unowned)s "
        " WHERE campaign_id = %(cid)s AND status = 'pending' AND rm_email IS NULL",
        {"cid": campaign_id, "unowned": UNOWNED_DETAIL})
    return cur.rowcount or 0


def materialize(cur, campaign_id, rules):
    """Freeze the rule tree into queue rows. Newest leads first; re-running can't
    duplicate a lead's slot."""
    where, params = compile_rules(rules)
    cur.execute(
        f"INSERT INTO dial_queue (id, campaign_id, oh_id, position, status) "
        f"SELECT gen_random_uuid(), %(cid)s, l.oh_id, "
        f"       row_number() OVER (ORDER BY l.created_at DESC), 'pending' "
        f"  FROM inventory l WHERE {BASE_PREDICATE} AND {where} "
        f"ON CONFLICT (campaign_id, oh_id) DO NOTHING",
        {**params, "cid": campaign_id})
    return cur.rowcount or 0


# ── calling-window helpers ───────────────────────────────────────────────────

def window_minutes(raw, fallback):
    """'HH:MM' → minutes past midnight. A malformed value falls back to the caller's
    bound, matching _in_window's "a broken window means always on"."""
    try:
        h, m = (int(x) for x in str(raw).split(":")[:2])
    except (ValueError, TypeError):
        return fallback
    return h * 60 + m


def windows_overlap(a_start, a_end, b_start, b_end):
    """Do two calling windows share any minute of the day? Half-open on purpose: a
    campaign ending at 13:00 and one starting at 13:00 do not overlap."""
    a0, a1 = window_minutes(a_start, 0), window_minutes(a_end, 24 * 60)
    b0, b1 = window_minutes(b_start, 0), window_minutes(b_end, 24 * 60)
    return a0 < b1 and b0 < a1


def window_has_passed(start, end, now=None):
    """Is this calling window already over for today? _in_window is start<=now<=end with
    no midnight wrap, so a window that closed earlier would let a campaign reach 'running'
    and dial nobody until tomorrow — refused at creation instead. A malformed or inverted
    window is NOT past (it's 'always on' / 'never open')."""
    try:
        h1, m1 = (int(x) for x in str(start).split(":")[:2])
        h2, m2 = (int(x) for x in str(end).split(":")[:2])
        window_start, window_end = time(h1, m1), time(h2, m2)
    except (ValueError, TypeError):
        return False
    current = now if now is not None else datetime.now(IST).time()
    if window_end < window_start:
        return False
    return current > window_end


def _in_window(start, end):
    """Calling hours are IST wall-clock. A blank or malformed window means always on."""
    try:
        h1, m1 = (int(x) for x in str(start).split(":")[:2])
        h2, m2 = (int(x) for x in str(end).split(":")[:2])
    except (ValueError, TypeError):
        return True
    now = datetime.now(IST).time()
    return time(h1, m1) <= now <= time(h2, m2)


# ── the tick ─────────────────────────────────────────────────────────────────

_POLL_CLOSE = (
    "UPDATE dial_queue "
    "   SET status   = CASE WHEN %(ends)s THEN 'done' ELSE status END, "
    "       ended_at = CASE WHEN %(ends)s THEN now() ELSE ended_at END, "
    "       outcome  = COALESCE(%(outcome)s, outcome), "
    "       answered = answered OR %(answered)s "
    " WHERE id = %(id)s AND status = 'dialing' "
    " RETURNING id, rm_email")


def poll_open_calls():
    """For calls ringing a while with no callback, ask Bonvoice how they went and close
    them. This is the fallback that advances the queue whether or not the callback URL is
    reachable; it only looks at calls older than POLL_AFTER_SECONDS, so a working webhook
    resolves almost everything first."""
    from ..api.bonvoice import fetch_call_state  # lazy: pulls flask, only needed here

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id, event_id FROM dial_queue "
                " WHERE status = 'dialing' AND event_id IS NOT NULL "
                "   AND dialed_at < now() - make_interval(secs => %(s)s) "
                " ORDER BY dialed_at LIMIT %(lim)s",
                {"s": POLL_AFTER_SECONDS, "lim": POLL_BATCH})
            rows = cur.fetchall()
    finally:
        conn.close()

    now = monotonic()
    for k in [k for k, t in _polled.items() if now - t > 3600]:
        _polled.pop(k, None)

    for row in rows:
        ev = row["event_id"]
        if now - _polled.get(ev, 0.0) < POLL_EVERY_SECONDS:
            continue  # a 20-minute call must not mean 400 requests
        _polled[ev] = now
        state = fetch_call_state(ev)
        if state is None:
            continue  # couldn't tell — leave it ringing; the stale reaper is the backstop
        ended, answered, status = state
        if not ended and not answered:
            continue
        conn = get_conn()
        try:
            with conn, conn.cursor() as cur:
                cur.execute(_POLL_CLOSE, {"id": row["id"], "ends": ended,
                                         "answered": answered, "outcome": status})
                cur.fetchone()
        finally:
            conn.close()
        if ended:
            log.info("dialer: closed %s from the call log (answered=%s status=%s)",
                     ev, answered, status)
        # Phase 5: Live Calls polls dial_queue for the RM, so no push here.


def tick_all():
    try:
        poll_open_calls()
    except Exception:  # noqa: BLE001 — polling is the fallback, never the blocker
        log.exception("dialer: polling open calls failed")

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE dial_queue SET status = 'done', ended_at = now(), "
                "       outcome = COALESCE(outcome, 'no callback') "
                " WHERE status = 'dialing' "
                "   AND dialed_at < now() - make_interval(secs => %(s)s)",
                {"s": STALE_AFTER_SECONDS})
            cur.execute("SELECT * FROM dial_campaigns WHERE status = 'running'")
            campaigns = cur.fetchall()
    finally:
        conn.close()

    for c in campaigns:
        try:
            _tick_campaign(dict(c))
        except Exception:  # noqa: BLE001 — one bad campaign must not stop the rest
            log.exception("dialer: campaign %s tick failed", c["id"])


def _tick_campaign(c):
    rms = [e for e in (c.get("rms") or []) if isinstance(e, str) and e]
    if not rms:
        return

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # leads that rang out without connecting get another turn, at the back of the
            # queue, once their cooldown has passed
            if (c["max_attempts"] or 1) > 1:
                cur.execute(
                    "UPDATE dial_queue q "
                    "   SET status = 'pending', event_id = NULL, position = position + 1000000 "
                    " WHERE q.campaign_id = %(cid)s AND q.status = 'done' "
                    "   AND q.attempts < %(max)s AND NOT q.answered "
                    "   AND q.ended_at < now() - make_interval(mins => %(cool)s)",
                    {"cid": c["id"], "max": c["max_attempts"], "cool": c["cooldown_minutes"] or 0})
            cur.execute(
                "SELECT rm_email, "
                "       count(*) FILTER (WHERE status = 'dialing')          AS live, "
                "       count(*) FILTER (WHERE status IN ('done','failed')) AS done, "
                "       max(ended_at)                                       AS last_end "
                "  FROM dial_queue WHERE campaign_id = %(cid)s AND rm_email IS NOT NULL "
                " GROUP BY rm_email", {"cid": c["id"]})
            load = cur.fetchall()
            cur.execute(
                "SELECT count(*) FILTER (WHERE status = 'pending') AS pending, "
                "       count(*) FILTER (WHERE status = 'done' AND attempts < %(max)s "
                "                        AND NOT answered) AS retryable "
                "  FROM dial_queue WHERE campaign_id = %(cid)s",
                {"cid": c["id"], "max": c["max_attempts"] or 1})
            counts = cur.fetchone()
    finally:
        conn.close()

    pending = int(counts["pending"] or 0)
    retryable = int(counts["retryable"] or 0)
    by_rm = {r["rm_email"]: r for r in load}

    if pending == 0:
        if not retryable and not any(r["live"] for r in load):
            conn = get_conn()
            try:
                with conn, conn.cursor() as cur:
                    cur.execute("UPDATE dial_campaigns SET status = 'done' WHERE id = %(cid)s",
                                {"cid": c["id"]})
            finally:
                conn.close()
            log.info("dialer: campaign %s finished", c["id"])
        return

    if not _in_window(c["window_start"], c["window_end"]):
        return

    now, gap = datetime.now(timezone.utc), c["gap_seconds"] or 0
    free = []
    for email in rms:
        r = by_rm.get(email)
        if r is None:
            free.append(email)
            continue
        if r["live"]:
            continue  # one live call per handset, always
        if gap and r["last_end"] and (now - r["last_end"]).total_seconds() < gap:
            continue  # still inside the pause the campaign asked for
        free.append(email)

    epoch = datetime.fromtimestamp(0, timezone.utc)
    if c["strategy"] == "least_load":
        free.sort(key=lambda e: by_rm[e]["done"] if e in by_rm else 0)
    else:  # round-robin: longest idle goes first
        free.sort(key=lambda e: (by_rm[e]["last_end"] or epoch) if e in by_rm else epoch)

    owned = c["strategy"] == "assigned"
    for email in free:
        _dial_next(c, email, owned)


def _dial_next(c, rm_email, owned):
    """Claim the next pending lead for this RM and ring them. `owned` restricts the claim
    to leads already stamped with this RM — that's the whole of the 'assigned' strategy."""
    # Reserved before the call is placed and stored with the claim: Bonvoice can fire the
    # hangup callback before its own HTTP response reaches us, and a slot whose event_id
    # landed late would never be released.
    event_id = bv.new_event_id()
    mine = "AND rm_email = %(rm)s" if owned else ""
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT phone FROM users WHERE lower(email) = lower(%(e)s) AND is_active",
                        {"e": rm_email})
            rm = cur.fetchone()
            # FOR UPDATE SKIP LOCKED: two ticks can't claim the same lead, so nobody is
            # dialled twice. outcome/detail cleared so a redial can't report a stale result.
            cur.execute(
                f"UPDATE dial_queue "
                f"   SET status = 'dialing', rm_email = %(rm)s, event_id = %(ev)s, "
                f"       outcome = NULL, detail = NULL, attempts = attempts + 1, "
                f"       dialed_at = now(), ended_at = NULL "
                f" WHERE id = (SELECT id FROM dial_queue "
                f"              WHERE campaign_id = %(cid)s AND status = 'pending' {mine} "
                f"              ORDER BY position, id LIMIT 1 FOR UPDATE SKIP LOCKED) "
                f" RETURNING id, oh_id, attempts",
                {"cid": c["id"], "rm": rm_email, "ev": event_id})
            item = cur.fetchone()
            if item is None:
                return False
            cur.execute("SELECT seller_phone FROM inventory WHERE oh_id = %(id)s",
                        {"id": item["oh_id"]})
            lead = cur.fetchone()
    finally:
        conn.close()

    rm_phone = bv.digits(rm["phone"] if rm else None)
    lead_phone = bv.digits(lead["seller_phone"] if lead else None)
    if not rm_phone:
        _release(item["id"], f"{rm_email} has no mobile number on file", retry=True)
        return True
    if not lead_phone:
        _release(item["id"], "lead has no usable phone number", retry=False)
        return True

    try:
        bv.place_bridge(rm_phone, lead_phone,
                        {"lead_id": str(item["oh_id"]), "actor": rm_email,
                         "campaign_id": str(c["id"])}, event_id=event_id)
    except bv.BonvoiceError as e:
        retry = item["attempts"] < (c["max_attempts"] or 1)
        _release(item["id"], str(e.message)[:300], retry=retry)
        return True

    log.info("dialer: campaign=%s rm=%s lead=%s event=%s", c["id"], rm_email,
             item["oh_id"], event_id)
    # Phase 5: the RM's Live Calls page polls dial_queue and sees this row go 'dialing'.
    return True


def _release(item_id, detail, retry):
    """The call was never placed — put the slot back or mark it failed."""
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE dial_queue "
                "   SET status = CASE WHEN %(retry)s THEN 'pending' ELSE 'failed' END, "
                "       detail = %(detail)s, "
                "       ended_at = CASE WHEN %(retry)s THEN NULL ELSE now() END, "
                "       position = position + CASE WHEN %(retry)s THEN 1000000 ELSE 0 END "
                " WHERE id = %(id)s",
                {"id": item_id, "detail": detail, "retry": retry})
    finally:
        conn.close()
    log.warning("dialer: dial not placed (%s) — %s", "requeued" if retry else "failed", detail)
