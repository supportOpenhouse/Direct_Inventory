# Configuration and operations

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `BONVOICE_BASE_URL` | `https://backend.pbx.bonvoice.com` | See the rewrite below |
| `BONVOICE_USERNAME` / `BONVOICE_PASSWORD` | — | Exchanged for a token at `/usermanagement/external-auth/` |
| `BONVOICE_TOKEN` | — | A pre-issued long-lived token; skips the exchange entirely |
| `BONVOICE_DID` | — | Caller ID both parties see, e.g. `7946350641` |
| `BONVOICE_CHANNEL_ID` | `1` | legA/legB channel id issued with the account |
| `BONVOICE_WEBHOOK_SECRET` | — | The `?token=` on the callback URL; empty disables the check |
| `BONVOICE_SYNC_INTERVAL_MINUTES` | `15` | Scheduled [pull sync](call-record-sync.md) |
| `BONVOICE_SYNC_LOOKBACK_DAYS` | `1` | Yesterday+today, so a 23:58 call survives the midnight tick |

`bonvoice_configured` = `BONVOICE_DID` **and** (`BONVOICE_TOKEN` **or**
`USERNAME`+`PASSWORD`). When false, `POST /v1/bonvoice/call` returns 503 with that exact
requirement in the message, and the scheduled sync silently no-ops.

Declared in [config.py](../../backend/app/config.py),
[.env.example](../../.env.example), [render.yaml](../../render.yaml).

## The `backend.` host rewrite

Every endpoint we use — auth, `autoCallBridging`, `callrecords` — is served by the
**`backend.`** host. The bare host ops hand out (`pbx.bonvoice.com`) answers nginx **405**
for all of them, which surfaced as a 502 on every click-to-call.

So `Settings.bonvoice_base` derives it rather than trusting config: `//pbx.` →
`//backend.pbx.`, a missing scheme gets `https://`, and an env var set to the empty string
falls back to the default (httpx rejects a schemeless URL). Setting the bare host cannot
break calling.

## Per-user setup

Every RM needs a **mobile number in Settings**. The bridge rings their handset first —
without a number there is nothing to ring, and both click-to-call and the auto-dialer
refuse (the dialer requeues the slot and records the reason).

Campaigns can only target **active users in a calling role** — enforced server-side, not
just in the picker.

## Webhook setup

1. Register `https://<host>/v1/bonvoice/webhook?token=<BONVOICE_WEBHOOK_SECRET>` in the
   Bonvoice account as the call-log callback.
2. Verify first with a `GET` on the same URL — it returns `{"status":"ok"}` when the
   token matches, `403` when it doesn't.
3. Either JSON or form-encoded delivery is fine; both are accepted regardless of the
   declared content type.

## Deployment topology

`render.yaml` documents running the scheduler as a separate Background Worker. In that
topology the process that flips a `dial_queue` row is **not** the one holding the RM's SSE
connection, so **`REDIS_URL` must be set** or Live Calls falls back to polling. See
[live-calls.md](live-calls.md#event-fan-out).

## Symptoms → cause

| Symptom | Look at |
|---|---|
| Every call 502s | The `backend.` host — a 405 from `pbx.bonvoice.com` |
| "Bonvoice rejected the call: DID is not configured" | `BONVOICE_DID` / channel id; the rejection came back as HTTP 200 with an error body |
| 503 "Calling isn't set up yet" | `bonvoice_configured` is false |
| 400 "Add your mobile number in Settings" | `users.phone` empty for the caller |
| Calls happen, no `call_logs` rows | Callback URL unregistered or token mismatch; the [sync](call-record-sync.md) will backfill them |
| RM stuck on "Ringing…" | No callback — the poller closes it after ~20s, the reaper after 420s |
| Rows exist but `lead_id` is NULL | Call wasn't placed from the portal; phone-matched only if the number matches a lead |
| Recording button dead | Zero-second call (URL dropped on purpose), or the file genuinely isn't there |
| Live Calls never updates live | No `REDIS_URL` with a split scheduler process |
| Campaign "running" but dialling nobody | Outside the IST calling window, or every RM already on a call |
| 401s after a long uptime | Cached token went stale — one forced re-auth is automatic; a permanent 401 means bad credentials |

## Tests

`backend/tests/test_bonvoice.py` (parsing, rejection detection, filters, record mapping),
`test_dialer.py` (compiler, windows, strategies), `test_live_calls.py` (snapshot shape,
scoping).
