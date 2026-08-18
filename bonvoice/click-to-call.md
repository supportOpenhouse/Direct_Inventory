# Click-to-call

The 📞 button in every lead worklist and on the lead-detail page. One press places one
bridged call.

**Nothing dials from the laptop.** Bonvoice rings the RM's own handset first (leg A);
only when they answer does it dial the lead (leg B) and join the two. That is why
`users.phone` is mandatory rather than nice to have, and why the toast says
"Ringing your phone (••••1234) — pick up to connect": otherwise nothing appears to
happen for several seconds.

Both parties see the account's DID as caller ID — neither ever sees the other's number.

## API

`POST /v1/bonvoice/call` — any signed-in user.

```json
{ "lead_id": "…uuid…" }
→ { "status": "ringing", "event_id": "a1b2…", "rm_phone_masked": "••••3844" }
```

Preconditions, each with its own error:

| Condition | Response |
|---|---|
| `BONVOICE_DID` + (token or user/pass) missing | 503 "Calling isn't set up yet" |
| No database | 503 |
| Lead not found | 404 |
| Lead has no usable phone | 400 |
| Caller has no mobile on file | 400 "Add your mobile number in Settings" |
| Bonvoice unreachable / rejected | 502 with their message |

## What goes to Bonvoice

`POST {base}/autoDialManagement/autoCallBridging/`, `Authorization: Token …`:

```jsonc
{
  "autocallType": "3",            // 3 = two-leg bridge (4 = TTS, 5 = voicebot)
  "destination":     "<rm 10 digits>",   "legACallerID": DID, "legAChannelID": CH,
  "legBDestination": "<lead 10 digits>", "legBCallerID": DID, "legBChannelID": CH,
  "ringStrategy": "ringall", "legADialAttempts": "1", "legBDialAttempts": "1",
  "eventID": "<16 hex chars>",
  "callBackParams": { "lead_id": "…", "actor": "rm@…" }   // echoed back verbatim
}
```

`place_bridge()` in [routers/bonvoice.py](../../backend/app/routers/bonvoice.py) is the
single place this is built — the auto-dialer calls the same function.

### Three details that bite

**Phone normalisation.** `_digits()` keeps the **last 10 digits**. Bonvoice accepts
`9846098460` / `09846098460` / `919846098460` / `+919846098460`; last-10 satisfies all
of them, and is the same key used to match leads and users everywhere else.

**A rejection is an HTTP 200.** Bonvoice answers 200 for both outcomes; the body is the
only signal. `{"error": "DID is not configured"}` is a failure, `{"responseType":
"Success"}` is not. `_rejection_reason()` reads it — and treats an *unparseable* body as
accepted, because the call may well have been placed and claiming failure would be
worse than staying quiet.

**Token caching.** `_auth_token()` exchanges `BONVOICE_USERNAME`/`PASSWORD` at
`/usermanagement/external-auth/` and caches the token process-locally, forever. There is
no documented expiry, so staleness is detected rather than guessed: a 401 triggers
exactly one forced re-auth and retry. Setting `BONVOICE_TOKEN` skips the exchange.

**`eventID` can be reserved.** Callbacks can land *before* the HTTP response does, so a
caller that needs to store the id first passes `event_id=` in. The auto-dialer does
exactly this; click-to-call doesn't need to.

## Frontend

[CallButton.tsx](../../frontend/src/components/CallButton.tsx) — sits where the initials
avatar would be in a lead row. `e.stopPropagation()` because rows navigate on click.
Spinner while pending, blue toast with the masked number on success, gold toast with the
server's message on failure.

## Where the call goes next

Nothing else happens on this request. The conversation is reported back through the
[webhook](call-log-webhook.md), which writes `call_logs` rows and — for dialer calls —
frees the RM's slot.
