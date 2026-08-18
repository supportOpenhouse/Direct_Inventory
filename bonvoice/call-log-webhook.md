# Call-log webhook (push)

How a call that happened becomes rows in `call_logs`, and how a hangup frees an
auto-dialer slot.

## The callback

`POST /v1/bonvoice/webhook?token=…` — configured once in the Bonvoice account.
`GET` the same URL is a smoke test that returns `{"status":"ok"}` if the token matches,
so the URL can be verified before handing it over.

Bonvoice fires **three lifecycle events per leg** — `callType` `0` initiated, `1`
answered, `2` hangup — so **up to six callbacks describe one conversation**. The handler
therefore acks instantly and persists in a background task (`asyncio.create_task`), the
same shape as the Gupshup webhook.

Auth is `?token=` compared with `secrets.compare_digest` against
`BONVOICE_WEBHOOK_SECRET`. An empty secret disables the check.

Body may be **JSON or `x-www-form-urlencoded`** — which one is an account setting, and
the declared content type is not always right, so `parse_body()` accepts both regardless.
Consequence: `callBackParams` arrives as an object on JSON and as a *JSON string* on
form-encoded, which is why `lead_id_from()` parses both.

An unreadable body still returns 200. Never make the PBX retry.

## `_persist()` — the upsert

One row per **leg**, primary key `(call_id, leg)`; `A` is the RM's handset, `B` the lead.
A bridged call is therefore two rows.

Duplicate and out-of-order deliveries have to converge, so every column is written with
`COALESCE(EXCLUDED.col, call_logs.col)` — a late "initiated" cannot blank the hangup's
`end_at` — and `answered` is OR-ed, never cleared.

| Column | Source |
|---|---|
| `lead_id` | `callBackParams.lead_id` — echoed back from the call we placed, **not** a phone match |
| `event_id` | our reserved id; links to `dial_queue` |
| `campaign_id` | looked up from `dial_queue` by `event_id` *at persist time* |
| `answered` | `callType == "1"` |
| `recording_url` | `ResourceURL` / `recordingURL`, read case-insensitively |
| `raw` | the whole callback body |

**Why `campaign_id` is resolved here and stored:** a retry clears `dial_queue.event_id`
minutes later, after which the link is unrecoverable. NULL means manual click-to-call.

A callback with no `callID` logs a warning and stores nothing — but only *after* the
dial slot has been released (below).

## Releasing the dial slot

`_release_dial_slot()` runs **first and separately**, deliberately: a callback with no
`callID`, or one whose log row fails to write, must still end the call as far as the
dialer is concerned. A stuck slot reads as "Ringing…" forever and silently costs that RM
the rest of the campaign.

```sql
UPDATE dial_queue
   SET status   = CASE WHEN :ends THEN 'done' ELSE status END,
       ended_at = CASE WHEN :ends THEN now() ELSE ended_at END,
       outcome  = COALESCE(:outcome, outcome),
       answered = answered OR :answered
 WHERE event_id = :eid AND status = 'dialing'
RETURNING id, rm_email
```

- Both legs report a hangup; `status = 'dialing'` makes the second a no-op.
- `answered` is OR-ed because the answer event arrives before the hangup, and it is what
  decides whether the lead is owed a retry.
- `RETURNING rm_email` avoids a second query when publishing the
  `{"type":"call_ended"}` event to the RM's [Live Calls](live-calls.md) channel — and
  only the leg that actually closed the slot publishes.

Everything in this function is wrapped so a failure logs and returns: the callback was
already acked.

## Failure modes

| Symptom | Cause |
|---|---|
| Calls happen, no rows appear | Webhook URL not registered, or `?token=` mismatch → 403 |
| RM stuck on "Ringing…" | Callback never arrived — the [poller](auto-dialer.md#the-poller-fallback) closes it after 20s, the stale reaper after 420s |
| Row exists, `lead_id` NULL | Call not placed from the portal — [the sync](call-record-sync.md) matches it by phone instead |
| No recording | Zero-second calls get a URL that 404s; the sync path drops those deliberately |
