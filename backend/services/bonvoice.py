"""Bonvoice PBX client — auth, phone helpers, and place_bridge.

Sync/requests port of the reference FastAPI implementation. Click-to-call and the
auto-dialer both call place_bridge(): Bonvoice rings the RM's own handset first
(leg A), and only when they answer does it dial the lead (leg B) and join them.
No audio touches the browser — the laptop only triggers the call.
"""
from __future__ import annotations

import logging
import re
from uuid import uuid4

import requests

from .. import config

log = logging.getLogger("bonvoice")

AUTOCALL_BRIDGE = "3"   # autocallType for a two-leg bridge (4 = TTS, 5 = voicebot)
CALL_ANSWERED = "1"     # callType on the lifecycle callback
CALL_HANGUP = "2"

# Token cache. No documented TTL, so it's held until a 401 forces a refresh rather
# than expiring on a guess. Process-local: re-authing per instance is one cheap call.
_token: dict = {"value": ""}


class BonvoiceError(Exception):
    """A call couldn't be placed. `.status` is the HTTP code to surface, `.message`
    the user-facing reason."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


def digits(phone) -> str:
    """Last 10 digits — satisfies 9846098460 / 09846098460 / 919846098460 /
    +919846098460, the same key used to match leads and users everywhere else."""
    d = re.sub(r"\D", "", phone or "")
    return d[-10:] if len(d) >= 10 else ""


def mask(phone: str) -> str:
    return ("•" * max(0, len(phone) - 4)) + phone[-4:] if phone else "—"


def new_event_id() -> str:
    """docs: unique alphanumeric, 8–16 chars."""
    return uuid4().hex[:16]


def _rejection_reason(r):
    """Why Bonvoice refused, or None if it accepted. Their API answers 200 for both
    outcomes, so the body is the only signal: {"error": ...} is a failure,
    responseType "Success" is not. An unparseable body is treated as accepted — the
    call may well have been placed, and claiming failure would be worse."""
    try:
        body = r.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    if body.get("error"):
        return str(body["error"])
    rtype = str(body.get("responseType", "")).lower()
    if rtype and rtype != "success":
        return str(body.get("responseDescription") or body.get("responseType"))
    return None


def auth_token(force: bool = False) -> str:
    """Exchange username/password for a token, cached. A pre-issued BONVOICE_TOKEN
    short-circuits the exchange entirely."""
    if config.BONVOICE_TOKEN:
        return config.BONVOICE_TOKEN
    if _token["value"] and not force:
        return _token["value"]
    try:
        r = requests.post(
            f"{config.bonvoice_base()}/usermanagement/external-auth/",
            json={"username": config.BONVOICE_USERNAME, "password": config.BONVOICE_PASSWORD},
            timeout=20,
        )
    except requests.RequestException as e:
        raise BonvoiceError(f"Couldn't reach Bonvoice auth: {e}")
    if r.status_code >= 300:
        raise BonvoiceError(f"Bonvoice auth failed: {r.text[:200]}")
    tok = ((r.json() or {}).get("data") or {}).get("token")
    if not tok:
        raise BonvoiceError("Bonvoice auth returned no token")
    _token["value"] = tok
    return tok


def place_bridge(rm_phone: str, lead_phone: str, callback_params: dict,
                 event_id: str | None = None) -> str:
    """Place one Click2Call bridge and return its eventID. Leg A rings the RM, leg
    B the lead. `callback_params` is echoed verbatim on every lifecycle callback,
    so whatever links the call back to a lead goes in there.

    Pass `event_id` to reserve it beforehand — callbacks can land before this
    returns, and a caller that stores the id afterwards would miss them.

    Raises BonvoiceError on anything that isn't an accepted call — including the
    HTTP-200-with-an-error-body case, how Bonvoice reports most rejections.
    """
    event_id = event_id or new_event_id()
    payload = {
        "autocallType": AUTOCALL_BRIDGE,
        "destination": rm_phone,               # leg A — rings the RM
        "ringStrategy": "ringall",
        "legACallerID": config.BONVOICE_DID,
        "legAChannelID": config.BONVOICE_CHANNEL_ID,
        "legADialAttempts": "1",
        "legBDestination": lead_phone,         # leg B — the lead
        "legBCallerID": config.BONVOICE_DID,
        "legBChannelID": config.BONVOICE_CHANNEL_ID,
        "legBDialAttempts": "1",
        "eventID": event_id,
        "callBackParams": callback_params,     # echoed back — links logs to leads
    }

    def _post(tok):
        return requests.post(
            f"{config.bonvoice_base()}/autoDialManagement/autoCallBridging/",
            json=payload, headers={"Authorization": f"Token {tok}"}, timeout=25,
        )

    try:
        r = _post(auth_token())
        if r.status_code == 401:               # cached token stale — re-auth once
            r = _post(auth_token(force=True))
    except requests.RequestException as e:
        log.warning("bonvoice call failed: %s", e)
        raise BonvoiceError(f"Couldn't reach Bonvoice: {e}")

    if r.status_code >= 300:
        log.warning("bonvoice rejected the call (%s): %s", r.status_code, r.text[:300])
        raise BonvoiceError(f"Bonvoice rejected the call: {r.text[:200]}")
    problem = _rejection_reason(r)
    if problem:
        log.warning("bonvoice rejected the call: %s", problem)
        raise BonvoiceError(f"Bonvoice rejected the call: {problem}")
    return event_id
