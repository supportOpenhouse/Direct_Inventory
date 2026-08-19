"""Bonvoice PBX API.

Phase 1: click-to-call. Later phases add the call-log webhook, the pull sync,
and the admin call-log list under this same blueprint.

Our "lead" is an inventory row keyed by oh_id; its phone is seller_phone. We send
the oh_id in callBackParams so Bonvoice echoes it back on the call-log callbacks,
letting logs attach by explicit id instead of a phone match.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import requests
from urllib.parse import parse_qsl

from flask import Blueprint, g, jsonify, request
from psycopg2.extras import Json

# Bonvoice pulled records are 12-hour Indian local time with no zone (see _pbx_dt).
IST = timezone(timedelta(hours=5, minutes=30))

from .. import config
from ..db import get_conn
from ..services import bonvoice as bv
from .auth import require_auth

log = logging.getLogger("bonvoice")
bp = Blueprint("bonvoice", __name__, url_prefix="/api/bonvoice")


@bp.post("/call")
@require_auth()
def bonvoice_call():
    """Ring the caller's own phone, then bridge to the lead. Both parties see the
    DID as caller ID — neither ever sees the other's number."""
    if not config.bonvoice_configured():
        return jsonify({
            "error": "Calling isn't set up yet — BONVOICE_DID plus either BONVOICE_TOKEN "
                     "or BONVOICE_USERNAME + BONVOICE_PASSWORD are missing.",
        }), 503

    body = request.get_json(silent=True) or {}
    oh_id = (body.get("oh_id") or body.get("lead_id") or "").strip()
    if not oh_id:
        return jsonify({"error": "oh_id required"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT seller_phone FROM inventory WHERE oh_id = %s", (oh_id,))
            lead = cur.fetchone()
            cur.execute("SELECT phone FROM users WHERE lower(email) = lower(%s)", (g.user["email"],))
            rm = cur.fetchone()
    finally:
        conn.close()

    if lead is None:
        return jsonify({"error": "lead not found"}), 404
    lead_phone = bv.digits(lead.get("seller_phone"))
    if not lead_phone:
        return jsonify({"error": "This lead has no usable phone number."}), 400
    rm_phone = bv.digits(rm.get("phone") if rm else None)
    if not rm_phone:
        # The bridge rings the caller's own handset first — no number, nothing to ring.
        return jsonify({
            "error": "Add your mobile number in Settings — the call rings your phone first.",
        }), 400

    try:
        event_id = bv.place_bridge(
            rm_phone, lead_phone,
            {"lead_id": oh_id, "actor": g.user["email"]},
        )
    except bv.BonvoiceError as e:
        return jsonify({"error": e.message}), e.status

    log.info("bonvoice call by=%s rm=%s lead=%s event=%s",
             g.user["email"], bv.mask(rm_phone), bv.mask(lead_phone), event_id)
    return jsonify({"status": "ringing", "event_id": event_id, "rm_phone_masked": bv.mask(rm_phone)})


# ── call-log webhook (push) ───────────────────────────────────────────────
#
# Bonvoice fires up to six callbacks per conversation; the handler acks instantly
# (always 200 — never make the PBX retry) and upserts one row per leg. Auth is the
# ?token= query param compared against BONVOICE_WEBHOOK_SECRET; an empty secret
# disables the check.

def _token_ok() -> bool:
    secret = config.BONVOICE_WEBHOOK_SECRET
    if not secret:
        return True   # empty secret disables the check
    return secrets.compare_digest(request.args.get("token", ""), secret)


def _field(record: dict, *names: str):
    """Case-insensitive field read — the log endpoint's exact casing isn't
    documented, so match loosely rather than read None off a capitalisation diff."""
    lowered = {str(k).lower(): v for k, v in record.items()}
    for n in names:
        v = lowered.get(n.lower())
        if v not in (None, ""):
            return v
    return None


def _dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


# Only log calls that are actually ours. A shared Bonvoice account's records (pulled and
# possibly via the webhook) carry other numbers' calls too. A call is "ours" if one of its
# Agent / Destination / Source / Display numbers matches a portal user's mobile OR the DID.
# Right now Bonvoice returns the RM's own number (not the DID) in these fields, so the
# user-phone match is what keeps our calls; the DID match covers the later switch to a DID.
# The number fields we check (last-10-digit match, since formats vary).
_OURS_NUMBER_KEYS = ("Agent", "DestinationNumber", "SourceNumber", "DisplayNumber")
_accept_cache = {"nums": None, "at": 0.0}
_ACCEPT_TTL = 60.0  # seconds — a burst of callbacks shouldn't hit the DB each time


def accept_numbers(force=False):
    """Last-10 phone numbers we recognise as ours: every portal user's mobile plus the
    configured DID. Cached ~60s. Returns None if it couldn't be loaded (→ fail open, don't
    drop logs)."""
    now = time.monotonic()
    if not force and _accept_cache["nums"] is not None and now - _accept_cache["at"] < _ACCEPT_TTL:
        return _accept_cache["nums"]
    nums = set()
    did = bv.digits(config.BONVOICE_DID)
    if did:
        nums.add(did)
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT phone FROM users WHERE phone IS NOT NULL AND btrim(phone) <> ''")
            for r in cur.fetchall():
                d = bv.digits(r["phone"])
                if d:
                    nums.add(d)
    except Exception:  # noqa: BLE001 — never drop legit logs over a transient DB blip
        log.exception("bonvoice: couldn't load accept-numbers; not filtering this record")
        return None
    finally:
        conn.close()
    _accept_cache["nums"] = nums
    _accept_cache["at"] = now
    return nums


def _is_ours(body, accept=None):
    """True if this call belongs to us — its Agent/Destination/Source/Display number is a
    portal user's mobile or the DID. accept=None loads (and caches) the set; an empty or
    unavailable set keeps everything (fail open, so nothing is dropped before phones/DID
    are configured)."""
    if accept is None:
        accept = accept_numbers()
    if not accept:  # None (load failed) or empty (no phones/DID yet) → don't filter
        return True
    for name in _OURS_NUMBER_KEYS:
        d = bv.digits(_field(body, name))
        if d and d in accept:
            return True
    return False


def parse_body(raw, content_type):
    """Bonvoice sends the same fields as JSON or x-www-form-urlencoded — which one
    is an account setting, so accept both regardless of the declared content type."""
    body = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw or "")
    if not body:
        return {}
    if "form-urlencoded" not in (content_type or ""):
        try:
            parsed = json.loads(body)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            pass  # mislabelled content type — fall through to form parsing
    return dict(parse_qsl(body))


def lead_id_from(params):
    """callBackParams arrives as an object on JSON callbacks and a JSON string on
    form-encoded ones. Returns our oh_id (a plain string), or None."""
    if isinstance(params, str):
        try:
            params = json.loads(params)
        except json.JSONDecodeError:
            return None
    if not isinstance(params, dict):
        return None
    v = params.get("lead_id") or params.get("oh_id")
    return str(v) if v else None


def _release_dial_slot(body):
    """Hangup frees the auto-dialer slot (Phase 4 dial_queue). Run first and
    separately: a callback that fails to write a log row must still end the call as
    far as the dialer is concerned. Best-effort — dial_queue may not exist yet, and
    the callback was already acked either way."""
    call_type = str(body.get("callType", ""))
    event_id = body.get("eventID")
    if not event_id or call_type not in (bv.CALL_ANSWERED, bv.CALL_HANGUP):
        return
    status = body.get("Status") or body.get("AgentStatus") or None
    answered = call_type == bv.CALL_ANSWERED or str(status or "").upper().startswith("ANSWER")
    ends = call_type == bv.CALL_HANGUP
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE dial_queue SET "
                "  status   = CASE WHEN %s THEN 'done' ELSE status END, "
                "  ended_at = CASE WHEN %s THEN now() ELSE ended_at END, "
                "  outcome  = COALESCE(%s, outcome), "
                "  answered = answered OR %s "
                "WHERE event_id = %s AND status = 'dialing' "
                "RETURNING id, rm_email",
                (ends, ends, status, answered, str(event_id)),
            )
            cur.fetchone()
        # Phase 5: publish call_ended to the freed RM's Live Calls channel.
    except Exception:  # noqa: BLE001 — dial_queue may not exist yet; callback acked
        pass
    finally:
        conn.close()


def _campaign_for_event(event_id):
    """Attribute the call to the campaign that placed it, while dial_queue still
    carries this event_id (a retry clears it minutes later). Best-effort."""
    if not event_id:
        return None
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT campaign_id FROM dial_queue WHERE event_id = %s LIMIT 1", (str(event_id),))
            row = cur.fetchone()
            return (row.get("campaign_id") if row else None)
    except Exception:  # noqa: BLE001
        return None
    finally:
        conn.close()


def _persist(body):
    """Upsert one leg with only what this lifecycle event knows. COALESCE precedence
    per column so a late 'initiated' can't blank the hangup's end_at; `answered` is
    OR-ed so it never flips back to false."""
    if not _is_ours(body):
        log.info("bonvoice: ignoring call — no RM mobile or DID among its numbers (call=%s)", body.get("callID"))
        return

    _release_dial_slot(body)   # first + separate, best-effort

    call_id = body.get("callID")
    if not call_id:
        log.warning("bonvoice: callback with no callID — logged nothing (type=%s event=%s)",
                    body.get("callType"), body.get("eventID"))
        return

    event_id = body.get("eventID") or None
    vals = {
        "call_id": str(call_id),
        "leg": str(body.get("Leg") or "A"),
        "event_id": event_id,
        "oh_id": lead_id_from(body.get("callBackParams")),
        "campaign_id": _campaign_for_event(event_id),
        "direction": body.get("Direction") or None,
        "source_number": body.get("SourceNumber") or None,
        "destination_number": body.get("DestinationNumber") or None,
        "display_number": body.get("DisplayNumber") or None,
        "status": body.get("Status") or None,
        "agent_status": body.get("AgentStatus") or None,
        "answered": str(body.get("callType", "")) == bv.CALL_ANSWERED,
        "start_at": _dt(body.get("StartTime")),
        "end_at": _dt(body.get("EndTime")),
        # ResourceURL (docs) / resourceurl (support) — read case-insensitively.
        "recording_url": _field(body, "ResourceURL", "recordingURL") or None,
        "raw": Json(body),
    }
    cols = list(vals.keys())
    set_parts = []
    for c in cols:
        if c in ("call_id", "leg"):
            continue
        if c == "answered":
            set_parts.append("answered = call_logs.answered OR EXCLUDED.answered")
        else:
            set_parts.append(f"{c} = COALESCE(EXCLUDED.{c}, call_logs.{c})")
    sql = (f"INSERT INTO call_logs ({', '.join(cols)}) "
           f"VALUES ({', '.join(['%s'] * len(cols))}) "
           f"ON CONFLICT (call_id, leg) DO UPDATE SET {', '.join(set_parts)}")
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, [vals[c] for c in cols])
    except Exception:  # noqa: BLE001 — callback already acked
        log.exception("bonvoice: failed to persist call log")
    finally:
        conn.close()


@bp.get("/webhook")
def bonvoice_verify():
    """Smoke test — confirms the URL + token before handing it to Bonvoice."""
    if not _token_ok():
        return jsonify({"error": "forbidden"}), 403
    return jsonify({"status": "ok"})


@bp.post("/webhook")
def bonvoice_webhook():
    """Up to six callbacks per conversation — ack instantly, always 200."""
    if not _token_ok():
        return ("forbidden", 403)
    try:
        body = parse_body(request.get_data(), request.headers.get("content-type", ""))
    except Exception:  # noqa: BLE001
        log.exception("bonvoice: unreadable callback body")
        return ("", 200)
    log.info("bonvoice callback type=%s leg=%s call=%s status=%s",
             body.get("callType"), body.get("Leg"), body.get("callID"), body.get("Status"))
    _persist(body)
    return ("", 200)


# ── pull sync ──────────────────────────────────────────────────────────────
#
# The webhook only reports calls placed after it was wired up. This pulls Bonvoice's
# own call records for a date range and upserts them through the same _persist path —
# history, handset-placed calls, anything a dropped callback lost. Re-persisting a
# record we already hold is free (upsert on (call_id, leg)). Shared by the admin
# "Sync from Bonvoice" button and the 15-min Render cron so both behave identically.

def log_records(body):
    """Dig the list of records out of whatever envelope Bonvoice wraps them in."""
    if isinstance(body, list):
        return [r for r in body if isinstance(r, dict)]
    if not isinstance(body, dict):
        return []
    for key in ("call_logs", "callLogs", "data", "result", "results", "records", "logs", "calls"):
        inner = body.get(key)
        if isinstance(inner, list):
            return [r for r in inner if isinstance(r, dict)]
        if isinstance(inner, dict):
            return log_records(inner)
    # a bare single record
    return [body] if any(_field(body, k) for k in ("callID", "Status", "EndTime", "callType")) else []


def read_call_state(records):
    """(ended, answered, status) read from a set of records. Neither end-marker nor
    hangup → the call is still up, so we say nothing and poll again."""
    ended = answered = False
    status = None
    for r in records:
        ctype = str(_field(r, "callType", "CallType") or "")
        st = _field(r, "Status", "AgentStatus")
        if _field(r, "EndTime", "end_time") or ctype == bv.CALL_HANGUP:
            ended = True
        if ctype == bv.CALL_ANSWERED or str(st or "").upper().startswith("ANSWER"):
            answered = True
        if st:
            status = str(st)
    return ended, answered, status


def _pbx_dt(value):
    """Pulled timestamps are '2026-08-04 11:04:51 AM' — 12-hour, no zone, Indian
    local. Naive would land in the DB as UTC and read 5½ hours early."""
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d %I:%M:%S %p").replace(tzinfo=IST)
    except (ValueError, TypeError):
        return _dt(value)


def _duration_secs(value):
    """'3 min 12 sec' → seconds. A pulled record has no EndTime, so this is the only
    way to know when the call finished."""
    m = re.search(r"(?:(\d+)\s*min)?\s*(?:(\d+)\s*sec)?", str(value or ""))
    if not m or not (m.group(1) or m.group(2)):
        return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)


def fetch_call_records(date_from, date_to, agent=None):
    """Every call record Bonvoice holds for a date range — POST /crm/callrecords/.
    `agent` narrows to one extension; omitted, the whole account's history returns."""
    payload = {"from": date_from, "to": date_to}
    if agent:
        payload["agent"] = agent
    url = f"{config.bonvoice_base()}/crm/callrecords/"

    def _post(tok):
        return requests.post(url, json=payload, headers={"Authorization": f"Token {tok}"}, timeout=90)

    r = _post(bv.auth_token())
    if r.status_code == 401:
        r = _post(bv.auth_token(force=True))
    if r.status_code >= 300:
        raise bv.BonvoiceError(f"Bonvoice call records failed ({r.status_code}): {r.text[:200]}", status=502)
    try:
        body = r.json()
    except ValueError:
        raise bv.BonvoiceError("Bonvoice returned a non-JSON call-record list", status=502)
    records = log_records(body)
    if not records:
        log.info("bonvoice: no call records parsed for %s..%s — raw: %s", date_from, date_to, r.text[:600])
    return records


def record_to_callback(rec):
    """Reshape one /crm/callrecords/ row into the callback shape _persist upserts.

    A pulled record is one row per conversation (not per leg) and names the parties
    as Customer + DisplayNumber rather than source/destination, so which is which
    depends on CallDirection. No lifecycle callType, no EndTime: connectedness comes
    off the status text, the end is start + CallDuration. Unmapped fields ride into raw."""
    _, answered, status = read_call_state([rec])
    customer = _field(rec, "Customer", "SourceNumber", "DestinationNumber")
    direction = str(_field(rec, "CallDirection", "Direction", "direction") or "")
    inbound = direction.lower().startswith("in")
    # Our side. Bonvoice fills DisplayNumber only on incoming records; on outgoing it's
    # null and the RM's handset is in Agent instead.
    did = _field(rec, "DisplayNumber", "did") or (None if inbound else _field(rec, "Agent", "agent"))
    start = _pbx_dt(_field(rec, "StartTime", "startTime", "start_time", "callDate"))
    secs = _duration_secs(_field(rec, "CallDuration", "Duration"))
    end = _pbx_dt(_field(rec, "EndTime", "endTime", "end_time"))
    if end is None and start and secs is not None:
        end = start + timedelta(seconds=secs)
    return {**rec,
            "callID": _field(rec, "callID", "call_id", "uniqueid", "uniqueId"),
            # records don't split legs; 'A' merges with the caller leg a callback wrote
            "Leg": _field(rec, "Leg", "leg") or "A",
            "eventID": _field(rec, "eventID", "event_id"),
            "callBackParams": _field(rec, "callBackParams", "callback_params"),
            "Direction": direction or None,
            "SourceNumber": customer if inbound else did,
            "DestinationNumber": did if inbound else customer,
            "DisplayNumber": did,
            "Status": status or _field(rec, "Status", "callStatus", "disposition"),
            # NOT Agent: on a pulled record that field is the RM's phone number
            "AgentStatus": _field(rec, "AgentStatus", "agentStatus"),
            # synthesised; answered is OR-ed in, so a false here can't unset a live callback
            "callType": bv.CALL_ANSWERED if answered else "",
            "StartTime": start.isoformat() if start else None,
            "EndTime": end.isoformat() if end else None,
            # their recording field is CallRecord; the callback calls it ResourceURL.
            # A 0-sec call's url answers "File not exist", so drop it rather than hand
            # the page a dead player.
            "ResourceURL": None if secs == 0 else
                _field(rec, "CallRecord", "ResourceURL", "recordingURL", "recording_url"),
            }


def attach_lead_and_actor(mapped):
    """Fill callBackParams for pulled records, which carry only phone numbers: Customer
    matched against inventory.seller_phone, Agent against users.phone, both on last-10
    digits. Returns how many records got a lead."""
    customers = {p for p in (bv.digits(m.get("Customer")) for m in mapped) if p}
    agents = {p for p in (bv.digits(m.get("Agent")) for m in mapped) if p}
    leads, users = {}, {}
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            if customers:
                cur.execute(
                    f"SELECT {_p10_sql('seller_phone')} AS p10, oh_id FROM inventory "
                    f"WHERE {_p10_sql('seller_phone')} = ANY(%s) ORDER BY created_at",
                    (sorted(customers),))
                # oldest first → the newest lead on a repeated number overwrites and wins
                for r in cur.fetchall():
                    leads[r["p10"]] = r["oh_id"]
            if agents:
                cur.execute(
                    f"SELECT {_p10_sql('phone')} AS p10, email FROM users "
                    f"WHERE {_p10_sql('phone')} = ANY(%s)", (sorted(agents),))
                for r in cur.fetchall():
                    users[r["p10"]] = r["email"]
    finally:
        conn.close()

    linked = 0
    for m in mapped:
        found = {}
        lead_oh = leads.get(bv.digits(m.get("Customer")))
        actor = users.get(bv.digits(m.get("Agent")))
        if lead_oh:
            found["lead_id"] = lead_oh
            linked += 1
        if actor:
            found["actor"] = actor
        if not found:
            continue
        existing = m.get("callBackParams")
        # an echoed lead id came from the call itself — never overwrite it with a guess
        m["callBackParams"] = {**found, **existing} if isinstance(existing, dict) else found
    return linked


def sync_calls(date_from, date_to, agent=None):
    """Pull Bonvoice's call records for a date range and upsert them."""
    records = fetch_call_records(date_from, date_to, agent)
    # Keep only calls that are ours (an RM's mobile or the DID among their numbers) — the
    # account-wide pull also returns other numbers' calls. Filter the raw record before
    # record_to_callback remaps its fields. One fresh accept-set for the whole batch.
    accept = accept_numbers(force=True)
    ours = [r for r in records if _is_ours(r, accept)]
    mapped = [m for m in (record_to_callback(r) for r in ours) if m["callID"]]
    linked = attach_lead_and_actor(mapped)
    # ponytail: one upsert per record, sequentially. A day is ~30 round trips on the
    # 15-min job — batch it if the window ever widens.
    for m in mapped:
        _persist(m)
    log.info("bonvoice: synced %s/%s call records (%s off-DID skipped, %s linked) for %s..%s",
             len(mapped), len(records), len(records) - len(ours), linked, date_from, date_to)
    return {"fetched": len(records), "stored": len(mapped),
            "skipped_off_did": len(records) - len(ours), "linked": linked}


def run_call_log_sync(trigger="scheduler"):
    """Scheduled counterpart of the Sync button. Rolling window, not 'today': a call
    at 23:58 is reported once, and a tick just after midnight asking for the new day
    alone would miss it. The lookback also re-covers calls whose callback dropped."""
    if not config.bonvoice_configured():
        log.info("bonvoice: sync skipped — not configured")
        return
    today = datetime.now(IST).date()
    date_from = str(today - timedelta(days=max(0, config.BONVOICE_SYNC_LOOKBACK_DAYS)))
    try:
        sync_calls(date_from, str(today))
    except Exception:  # noqa: BLE001 — a failed pull must never kill the scheduler
        log.exception("bonvoice: scheduled call-log sync failed (%s)", trigger)


def fetch_call_state(event_id):
    """Ask Bonvoice how the call for event_id is doing (Phase 4 poller). None = can't tell."""
    def _get(tok):
        return requests.get(f"{config.bonvoice_base()}/get-autocall-log/{event_id}/",
                            headers={"Authorization": f"Token {tok}"}, timeout=20)

    try:
        r = _get(bv.auth_token())
        if r.status_code == 401:
            r = _get(bv.auth_token(force=True))
    except (requests.RequestException, bv.BonvoiceError) as e:
        log.warning("bonvoice: call-log fetch failed for %s: %s", event_id, e)
        return None
    if r.status_code >= 300:
        log.warning("bonvoice: call-log %s returned %s: %s", event_id, r.status_code, r.text[:200])
        return None
    try:
        records = log_records(r.json())
    except ValueError:
        log.warning("bonvoice: call-log %s wasn't JSON: %s", event_id, r.text[:200])
        return None
    if not records:
        log.info("bonvoice: no call records parsed for %s — raw: %s", event_id, r.text[:600])
        return None
    return read_call_state(records)


@bp.post("/calls/sync")
@require_auth("admin")
def sync_call_records():
    """Backfill the call log from Bonvoice for a date range (admin button)."""
    if not config.bonvoice_configured():
        return jsonify({"error": "Bonvoice isn't configured."}), 503
    date_from = request.args.get("from")
    date_to = request.args.get("to")
    agent = request.args.get("agent") or None
    if not date_from or not date_to:
        return jsonify({"error": "from and to (YYYY-MM-DD) are required"}), 400
    try:
        return jsonify(sync_calls(date_from, date_to, agent))
    except bv.BonvoiceError as e:
        return jsonify({"error": e.message}), e.status


# ── call-log list (admin page) ─────────────────────────────────────────────
#
# One conversation is two legs (A = RM handset, B = lead), so a bridged call is two
# rows. The recording arrives as recording_url on the hangup callback.

CALL_LOG_FROM = "FROM call_logs c LEFT JOIN inventory l ON l.oh_id = c.oh_id"

# The actor who dialled: the auto-dialer writes placed_by directly, a click-to-call
# echoes it inside callBackParams. Defined once so SELECT and filter never disagree.
PLACED_BY_SQL = "COALESCE(c.placed_by, c.raw->'callBackParams'->>'actor')"

# "Placed by" sentinels — neither can collide with a real actor (every actor is an email).
PLACED_BY_LEAD = "by-lead"      # they rang us; the lead is on the From side
PLACED_BY_UNKNOWN = "unknown"   # nobody recorded, and not lead-placed either

# label → [from, to) seconds; `to` None = open-ended. Half-open + contiguous so every
# duration lands in exactly one bucket.
DURATION_BUCKETS = {
    "<1 min": (0, 60),
    "1-3 mins": (60, 180),
    "3-5 mins": (180, 300),
    "5+ mins": (300, None),
}


def _p10_sql(col):
    """Last 10 digits of a phone column — the one key every format agrees on.
    Bonvoice '9220633844', users.phone '919999999999', seller_phone '+91 99997 99588'
    all reduce to the same 10."""
    return rf"right(regexp_replace(coalesce({col}, ''), '\D', '', 'g'), 10)"


def _lead_side_sql():
    """Which side of From → To the lead sits on."""
    return ("CASE WHEN c.oh_id IS NULL OR l.seller_phone IS NULL THEN NULL "
            f"WHEN c.source_number IS NOT NULL AND {_p10_sql('l.seller_phone')} = {_p10_sql('c.source_number')} "
            "THEN 'from' ELSE 'to' END")


def call_log_filters(q, answered, campaign_id=None, placed_by=None, duration=None):
    """WHERE clause + positional params for the call-log list. Split out so the same
    clause drives both the page and its count."""
    where, params = [], []
    if campaign_id:
        # Previous Campaigns reuses this endpoint so a campaign's calls render identically.
        where.append("c.campaign_id = %s")
        params.append(campaign_id)
    if q:
        parts = ["c.source_number ILIKE %s", "c.destination_number ILIKE %s",
                 "c.display_number ILIKE %s", "l.seller_name ILIKE %s"]
        like = f"%{q}%"
        params += [like, like, like, like]
        # a search that's really a phone number matches on digits
        q10 = bv.digits(q)
        if q10:
            for col in ("c.source_number", "c.destination_number", "c.display_number", "l.seller_phone"):
                parts.append(f"{_p10_sql(col)} = %s")
                params.append(q10)
        where.append("(" + " OR ".join(parts) + ")")
    if answered is not None:
        where.append("c.answered = %s")
        params.append(answered)
    if placed_by:
        if placed_by == PLACED_BY_LEAD:
            where.append(f"({_lead_side_sql()}) = 'from'")
        elif placed_by == PLACED_BY_UNKNOWN:
            # no actor AND not lead-placed — else every inbound call lands in Unknown too
            where.append(f"{PLACED_BY_SQL} IS NULL AND ({_lead_side_sql()}) IS DISTINCT FROM 'from'")
        else:
            # filtering by an RM must not return calls the lead placed (keeps the three
            # choices a true partition)
            where.append(f"{PLACED_BY_SQL} = %s AND ({_lead_side_sql()}) IS DISTINCT FROM 'from'")
            params.append(placed_by)
    if duration:
        lo, hi = DURATION_BUCKETS.get(duration, (None, None))
        if lo is not None:
            secs = "EXTRACT(EPOCH FROM (c.end_at - c.start_at))"
            bounds = f"{secs} >= %s" + (f" AND {secs} < %s" if hi is not None else "")
            where.append(f"c.start_at IS NOT NULL AND c.end_at IS NOT NULL AND {bounds}")
            params.append(lo)
            if hi is not None:
                params.append(hi)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    return clause, params


# ── role scoping ───────────────────────────────────────────────────────────
#
# The Call Log is visible to RMs and managers too, but scoped by phone number:
# an RM sees only calls involving their own mobile, a manager sees their whole team's
# (their RMs + themselves), an admin sees everything.

def _my_call_numbers(user, own=False):
    """Last-10 phone numbers whose calls this user may see. admin (own=False) → None
    (unscoped). manager (own=False) → team RMs' + own. everyone else (or own=True) →
    own only. Empty set = no visible calls."""
    if user["role"] == "admin" and not own:
        return None
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            if user["role"] == "manager" and not own:
                cur.execute(
                    "SELECT phone FROM users WHERE phone IS NOT NULL AND btrim(phone) <> '' "
                    "  AND (id = %s OR manager = %s)", (user["id"], user["id"]))
            else:
                cur.execute("SELECT phone FROM users WHERE id = %s AND phone IS NOT NULL", (user["id"],))
            return {d for d in (bv.digits(r["phone"]) for r in cur.fetchall()) if d}
    finally:
        conn.close()


def _numbers_clause(nums, cols=("c.source_number", "c.destination_number", "c.display_number")):
    """(sql, params) — rows where any of `cols` (last-10 digits) is one of `nums`."""
    cond = "(" + " OR ".join(f"{_p10_sql(col)} = ANY(%s)" for col in cols) + ")"
    return cond, [sorted(nums)] * len(cols)


def _my_scope_data(user):
    """(phone_numbers_last10:set, user_ids:list) for this user's call scope. A manager's
    set spans their whole team (their RMs + themselves)."""
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            if user["role"] == "manager":
                cur.execute("SELECT id, phone FROM users WHERE id = %s OR manager = %s",
                            (user["id"], user["id"]))
            else:
                cur.execute("SELECT id, phone FROM users WHERE id = %s", (user["id"],))
            rows = cur.fetchall()
    finally:
        conn.close()
    nums = {d for d in (bv.digits(r["phone"]) for r in rows) if d}
    return nums, [r["id"] for r in rows]


def _role_scope(user):
    """(sql, params) limiting the call log for a non-admin. A call is theirs if its number
    matches their (or their team's) mobile, OR it's a call for a lead assigned to them —
    the latter is what surfaces INCOMING calls, whose number fields hold the DID + lead's
    number, not the RM's. None = admin (unscoped)."""
    if user["role"] == "admin":
        return None, []
    nums, ids = _my_scope_data(user)
    conds, params = [], []
    if nums:
        ncond, np = _numbers_clause(nums)
        conds.append(ncond)
        params += np
    if ids:
        conds.append("c.oh_id IN (SELECT oh_id FROM inventory WHERE assigned_rm_ids && %s::int[])")
        params.append(sorted(ids))
    return ("(" + " OR ".join(conds) + ")" if conds else "FALSE"), params


# lead name → RM name for the "Placed by" column. Prefers the actor who dialled
# (placed_by / callBackParams.actor, resolved to their name); falls back to the lead's
# first assigned RM (so an incoming call still credits the RM).
RM_NAME_SQL = (
    "COALESCE("
    f"  (SELECT u.name FROM users u WHERE lower(u.email) = lower({PLACED_BY_SQL})), "
    "  (SELECT u2.name FROM users u2 WHERE u2.id = l.assigned_rm_ids[1]))"
)


@bp.get("/calls")
@require_auth()
def call_log():
    """Every call leg Bonvoice has reported, newest first — backs the Call Log page.
    Scoped by role: RM = own number, manager = team, admin = all."""
    q = request.args.get("q") or None
    a = request.args.get("answered")
    answered = {"true": True, "false": False}.get(a) if a is not None else None
    campaign_id = request.args.get("campaign_id") or None
    placed_by = request.args.get("placed_by") or None
    duration = request.args.get("duration") or None
    limit = min(max(request.args.get("limit", default=50, type=int) or 50, 1), 200)
    offset = max(request.args.get("offset", default=0, type=int) or 0, 0)

    clause, params = call_log_filters(q, answered, campaign_id, placed_by, duration)

    # Non-admins: their own/team calls — matched by number OR by the lead's assignment
    # (the latter surfaces incoming calls, whose numbers are the DID + lead, not the RM).
    scope_cond, scope_params = _role_scope(g.user)
    if scope_cond is not None:
        clause = (clause + " AND " + scope_cond) if clause else (" WHERE " + scope_cond)
        params = [*params, *scope_params]

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"SELECT count(*) AS n {CALL_LOG_FROM}{clause}", params)
            total = cur.fetchone()["n"]
            cur.execute(f"""
                SELECT c.call_id, c.leg, c.event_id, c.oh_id, l.seller_name AS lead_name,
                       c.direction, c.source_number, c.destination_number, c.display_number,
                       c.status, c.agent_status, c.answered, c.start_at, c.end_at, c.recording_url,
                       {PLACED_BY_SQL} AS placed_by, {RM_NAME_SQL} AS rm_name,
                       {_lead_side_sql()} AS lead_side
                {CALL_LOG_FROM}{clause}
                 ORDER BY COALESCE(c.start_at, c.created_at) DESC
                 LIMIT %s OFFSET %s""", [*params, limit, offset])
            rows = cur.fetchall()
    finally:
        conn.close()
    return jsonify({"items": rows, "total": total})


@bp.get("/calls/actors")
@require_auth()
def call_log_actors():
    """Distinct people who placed a call — the "Calls placed by" dropdown. Server-side
    because the page holds only 50 rows; deriving from screen would hide off-page RMs."""
    scope_cond, scope_params = _role_scope(g.user)
    extra, eparams = "", []
    if scope_cond is not None:
        extra, eparams = " AND " + scope_cond, scope_params
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # {value: actor email, label: their name} so the dropdown shows names.
            cur.execute(
                f"SELECT DISTINCT {PLACED_BY_SQL} AS email, "
                f"       (SELECT u.name FROM users u WHERE lower(u.email) = lower({PLACED_BY_SQL})) AS name "
                f"{CALL_LOG_FROM} WHERE {PLACED_BY_SQL} IS NOT NULL{extra} ORDER BY 2 NULLS LAST, 1",
                eparams)
            rows = cur.fetchall()
    finally:
        conn.close()
    return jsonify({"items": [{"value": r["email"], "label": r["name"] or r["email"]} for r in rows]})


# ── incoming-call notifications ──────────────────────────────────────────────
#
# An inbound call (a lead ringing the DID → routed to the RM) surfaces as a top-bar
# bell for the RM whose number it reached, until they acknowledge it. Scoped to the
# user's OWN number (not the team).

@bp.get("/incoming")
@require_auth()
def incoming_calls():
    """Unacknowledged inbound calls involving the current user's own mobile."""
    nums = _my_call_numbers(g.user, own=True)
    if not nums:
        return jsonify({"items": [], "count": 0})
    cond, cparams = _numbers_clause(nums)
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # one row per conversation (call_id), newest first
            cur.execute(
                f"SELECT c.call_id, max(c.oh_id) AS oh_id, max(l.seller_name) AS lead_name, "
                f"       max(c.source_number) AS source_number, max(c.display_number) AS display_number, "
                f"       max(c.start_at) AS start_at "
                f"  FROM call_logs c LEFT JOIN inventory l ON l.oh_id = c.oh_id "
                f" WHERE c.direction ILIKE 'in%%' AND NOT c.acknowledged AND {cond} "
                f" GROUP BY c.call_id ORDER BY max(c.start_at) DESC NULLS LAST LIMIT 50",
                cparams)
            rows = cur.fetchall()
    finally:
        conn.close()
    return jsonify({"items": rows, "count": len(rows)})


@bp.post("/incoming/ack")
@require_auth()
def ack_incoming():
    """Acknowledge the user's incoming calls — one call_id in the body, or all if omitted."""
    nums = _my_call_numbers(g.user, own=True)
    if not nums:
        return jsonify({"acknowledged": 0})
    call_id = (request.get_json(silent=True) or {}).get("call_id")
    cond, cparams = _numbers_clause(nums)
    sql = (f"UPDATE call_logs c SET acknowledged = TRUE "
           f"WHERE c.direction ILIKE 'in%%' AND NOT c.acknowledged AND {cond}")
    params = list(cparams)
    if call_id:
        sql += " AND c.call_id = %s"
        params.append(str(call_id))
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            n = cur.rowcount
    finally:
        conn.close()
    return jsonify({"acknowledged": n})


@bp.get("/leads/<oh_id>/calls")
@require_auth()
def lead_calls(oh_id):
    """Call history for one lead, newest first — the per-lead activity card."""
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                SELECT call_id, leg, direction, status, agent_status, answered,
                       start_at, end_at, recording_url
                  FROM call_logs WHERE oh_id = %s
                 ORDER BY start_at DESC NULLS LAST LIMIT 50""", (oh_id,))
            rows = cur.fetchall()
    finally:
        conn.close()
    return jsonify({"items": rows})
