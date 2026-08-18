# Live Calls (the RM's page)

The auto-dialer rings the RM's handset first and bridges the lead second — so without
this page the RM answers a call knowing nothing about who is on the other end.

Three sections: **who they're on with now**, **who's queued**, and **today's calls** with
whether the result has been marked.

Deliberately separate from `routers/dialer.py`, which is admin-only. Everything here is
scoped to the caller and returns only their own rows, so it runs on `current_user`.

## Endpoints

`GET /v1/dialer/my-calls` — the snapshot:

```jsonc
{
  "campaign": { "id", "name", "strategy", "window_start", "window_end" } | null,
  "upcoming_is_shared": true,      // round_robin/least_load: the next lead may ring
                                   // somebody else's phone, and the UI must say so
  "now_calling": { …lead… } | null,
  "upcoming":  [ …leads… ],
  "completed": [ …today's calls, newest first… ]
}
```

`now_calling` carries everything needed to open the call: name, phone, society, city,
configuration, budget, stage, `miss_count`, `ever_connected`.

The no-database branch returns **every** key. A missing `upcoming_is_shared` reads as
`undefined` on the page, and a shared pool would then render as if those leads were this
RM's own.

Today's boundary is **IST on both sides** — calling windows are IST wall-clock, so the
RM's "today" is the IST day; comparing in UTC would clear the list at 05:30 IST.

`GET /v1/dialer/my-calls/stream` — SSE. Carries only a nudge,
`{"type": "call_started" | "call_ended", "queue_item_id": …}`; the page refetches
`/my-calls`. One authoritative query builds the payload and the stream never rebuilds it,
so the two can't drift.

Consumed with `fetch()` + `ReadableStream`, not `EventSource`: auth is a Bearer header
and `EventSource` can't set headers — the usual `?token=` workaround would put the JWT in
access logs and referrers. A keepalive frame is flushed immediately so "connected" is
honest, then every `_KEEPALIVE_SECONDS`. Response sets `X-Accel-Buffering: no` to stop a
proxy buffering the stream.

`/my-calls` doubles as the **polling fallback**: with no Redis across a split scheduler
process, or a dropped connection, the page polls and degrades to a few seconds of
latency rather than to nothing.

## Event fan-out

[events.py](../../backend/app/events.py) — Redis when `REDIS_URL` is set, in-process
otherwise. This matters more than it does for the cache: `render.yaml` documents running
the scheduler as a **separate Background Worker**, and in that topology the process that
flips a `dial_queue` row is *not* the one holding the RM's SSE connection. Redis is what
carries the event across; the in-process path is correct only on a single instance.

`rm_channel(email)` lowercases, because the publisher reads `rm_email` off `dial_queue`
and the subscriber reads it off the JWT — an RM stored as `A@x.com` would otherwise
publish to a channel their own page never joins.

Publishing is best-effort and never raises. Every publish site sits inside a call
transition (`_dial_next`, the hangup callback, the poller) where raising would strand a
slot on "Ringing…" for the rest of the campaign, and the REST snapshot re-reads the truth
anyway. Per-connection queues are bounded at 32: a tab that stopped reading is dropped,
not grown unboundedly. A dropped event costs one refetch.

Published by:

| Event | Where |
|---|---|
| `call_started` | `_dial_next()` after the bridge is accepted |
| `call_ended` | `_release_dial_slot()` on hangup, and `poll_open_calls()` when no callback came |

## Marking the result

`POST /v1/leads/{lead_id}/call-result` with an optional `queue_item_id`.

`dial_queue.call_result` (`connected` | `missed`) is **the RM's** view, distinct from
`outcome`, which is the PBX's (`ANSWER` / `NOANSWER` / `no callback`): a call Bonvoice
reports as answered can still be a wrong number, and only the RM knows that. NULL is what
drives the **needs result** badge.

The queue row is verified server-side to be *this RM's* **and** for *this lead* — the
client sends the id, but whether it is theirs is never the client's call. Matching the
lead too stops a valid id of one's own stamping a result onto a different lead.

Owning the row also **waives the "No" cooldown**. The guard exists to stop an RM
hammering "No" without dialling; a campaign call was placed by the scheduler, not chosen
by the RM — and without the waiver, a campaign whose `cooldown_minutes` is under the
guard window redials inside it and the RM's second result is silently thrown away.

`connected=false` requires a reason and notes, writes a call note, bumps `miss_count`
and moves the stage (Did Not Pick → +3h, Switched Off → +6h, Invalid Number → Rejected;
10 consecutive misses on a never-connected lead → RNR).

## Frontend

[LiveCalls.tsx](../../frontend/src/pages/LiveCalls.tsx), gated on `isCallingRm`, using
`useEventStream` with the `/my-calls` polling fallback.

**Nothing here interrupts.** A finished call drops into Today carrying its badge and
waits: `gap_seconds` defaults to 0, so the next lead can ring the instant the previous
hangup lands, and a modal thrown up at that moment would be fighting a live call.
