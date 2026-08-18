# Call-record sync (pull)

The [webhook](call-log-webhook.md) only ever reports calls placed after it was wired up.
This pulls in everything else: history, calls dialled straight from a handset, and
anything a dropped callback lost.

Two entry points, one implementation (`sync_calls()`), so the button and the job can't
behave differently.

## Admin backfill

`POST /v1/bonvoice/calls/sync?from=YYYY-MM-DD&to=YYYY-MM-DD[&agent=<ext>]` — admin only.
Fronted by the **Sync from Bonvoice** control on the Call Log page, defaulting to the
last 30 days ("why isn't that call here?" range).

```json
{ "fetched": 412, "stored": 409, "linked": 271 }
```

`linked` = how many got a `lead_id`.

## Scheduled job

`run_call_log_sync()`, registered in
[workers/scheduler.py](../../backend/app/workers/scheduler.py) as `bonvoice_call_sync`,
every `BONVOICE_SYNC_INTERVAL_MINUTES` (default 15) under a distributed lock so only one
instance runs it.

It syncs a **rolling window**, `today - BONVOICE_SYNC_LOOKBACK_DAYS … today` (IST),
not just "today". A call at 23:58 is only reported once, and a tick just after midnight
asking for the new day alone would never see it. The lookback also re-covers dropped
callbacks. Re-persisting a record already held is free — `_persist` upserts on
`(call_id, leg)`.

It no-ops when Bonvoice isn't configured, and swallows every exception: a failed pull
must never kill the scheduler.

## Reshaping a pulled record

`POST {base}/crm/callrecords/` with `{"from", "to", "agent"?}`. `log_records()` unwraps
whatever envelope comes back (`call_logs`, `data`, `results`, a bare list, or a single
record); an empty parse logs the raw body once, which is the only way to see an
unexpected shape without a live account.

A pulled record is **one row per conversation, not per leg**, and differs from a
callback in every way that matters. `record_to_callback()` translates:

| Callback field | Where it comes from in a pulled record |
|---|---|
| `Leg` | absent → forced to `'A'`, so it merges with the caller leg a callback wrote |
| `SourceNumber` / `DestinationNumber` | `Customer` and our DID, **swapped by `CallDirection`** |
| our DID | `DisplayNumber`, **but that's only filled on inbound** — outbound puts the RM's handset in `Agent` |
| `callType` | absent → synthesised from the status text (`ANSWER…`) |
| `EndTime` | absent → `StartTime + CallDuration` |
| `ResourceURL` | their field is `CallRecord`; **dropped when duration is 0**, since that URL answers "File not exist" |
| `AgentStatus` | `AgentStatus` only — *never* `Agent`, which holds a phone number here |

Unmapped fields ride along untouched into `raw`.

Timestamps come back as `2026-08-04 11:04:51 AM` — 12-hour, unlabelled, **IST**.
`_pbx_dt()` stamps `+05:30`; treating them as naive would store them 5½ hours early.

## Attaching leads and actors

A pulled record carries no `callBackParams`, so `attach_lead_and_actor()` synthesises
them by phone: `Customer` against `leads.phone`, `Agent` against `users.phone`, both
compared on their **last 10 digits** in SQL.

- Leads are ordered oldest-first so the **newest** lead on a repeated number wins.
- An echoed `lead_id` is never overwritten by a guess: `{**found, **existing}`.

`sync_calls()` then upserts each mapped record through the same `_persist()` the webhook
uses — so the two paths converge on identical rows.

> `# ponytail:` one upsert per record, sequentially. A day is ~30 round trips on the
> 15-minute job; batch it only if the window ever widens.

## Per-call state pull

Separate from the bulk pull: `fetch_call_state(event_id)` hits
`GET {base}/get-autocall-log/{eventID}/` and returns `(ended, answered, status)`. This is
what the [auto-dialer's poller](auto-dialer.md#the-poller-fallback) uses to advance the
queue when no callback arrives. `None` means "couldn't tell" — leave the call ringing.
