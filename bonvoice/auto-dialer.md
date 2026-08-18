# Auto-dialer campaigns

Point a rule tree at the lead table, hand the result to a pool of RMs, and keep every
one of them on a call until the queue drains.

Admin-only — a campaign rings *other people's* phones.
Compose on **Schedule Campaign**; monitor on **Previous Campaigns**. Closing the tab
stops nothing: the loop runs server-side.

**Concurrency is the size of the pool.** Click2Call rings the RM's own handset first, so
one RM can hold exactly one live call. Three RMs = three calls at a time — which is also
why the server refuses two running campaigns that share an RM at overlapping hours.

## Data model

`dial_campaigns` — name, `rules` (JSONB tree), `rms` (JSONB emails), `strategy`,
`gap_seconds`, `window_start/end`, `max_attempts`, `cooldown_minutes`,
`status` = `draft | running | paused | done`.

`dial_queue` — one row per lead per campaign (unique on `(campaign_id, lead_id)`):

```
pending ──claim──▶ dialing ──hangup callback / poller──▶ done
   ▲                  │                                   │
   └──── retry ───────┘        failed  |  skipped  ◀──────┘
```

`status` is the whole scheduler. Notable columns: `event_id` (links to the call),
`answered` (PBX view, decides whether a retry is owed), `outcome` (PBX status text),
`detail` (why a dial failed, verbatim), `call_result` (what the *RM* said — see
[live-calls.md](live-calls.md)).

## The rule compiler

The AND/OR tree from the builder is **untrusted input**. Every field, operator and value
goes through a whitelist and comes out as a bound parameter; nothing from the client is
ever interpolated into SQL. `compile_rules()` raises `ValueError` on anything else, and
the create endpoint compiles *before* writing anything.

Whitelisted fields (`FIELDS` in [services/dialer.py](../../backend/app/services/dialer.py)):

| Field | Kind | Operators |
|---|---|---|
| society, city, source, stage, assigned_to | multi | `IN`, `NOT IN` |
| created_at | daterange | `BETWEEN` |
| miss_count | number | `= <= >= < >` |
| ever_connected | bool | `IS` |

Limits: depth 4, 200 values per `IN`. `GET /v1/dialer/fields` serves this same list plus
the distinct values currently in the data, so the builder and the compiler cannot drift.

Semantics worth knowing:
- An empty group or empty multi-select compiles to `TRUE` — "no filter", matching the
  live preview.
- `NOT IN` includes NULLs (`col IS NULL OR col NOT IN (…)`) — SQL says UNKNOWN, a human
  says "not one of them".
- A date range's end date is inclusive of the whole day.
- Never dialable regardless of rules: `BASE_PREDICATE` = has a phone, not `is_test`.

`POST /v1/dialer/preview` returns the live match count as the tree is edited. Under
`assigned` it counts only leads the chosen RMs actually own — otherwise it would
overstate the campaign.

## Strategies

| Strategy | Behaviour |
|---|---|
| `assigned` | Each lead is called by the RM it is already assigned to |
| `round_robin` | Longest-idle RM takes the next lead |
| `least_load` | Whoever has made the fewest calls so far |

`assigned` stamps `rm_email` on every queue row at creation (`assign_owners`), matching
`leads.assigned_to` — free text that diverges by source, so an owner is matched on full
name, first name **and** `assignment_name` (`aliases_for()`). Leads owned by nobody in
the pool are `skipped` immediately with `detail = "not assigned to anyone in this pool"`;
a queue nobody may claim would never drain.

That `detail` string is a shared constant because the stats have to tell the two kinds of
skip apart — never-targeted vs targeted-but-Stopped. Counting them together once made a
4-lead campaign report 1727 targeted.

## Creating and controlling

```
GET  /v1/dialer/fields                     builder vocabulary + callable RMs
POST /v1/dialer/preview                    live match count
GET  /v1/dialer/campaigns                  list + rollup counts
POST /v1/dialer/campaigns                  create (start=true dials immediately)
GET  /v1/dialer/campaigns/{id}             live panel: counts, per-RM state, feed
POST /v1/dialer/campaigns/{id}/{start|pause|stop}
```

Refused at create **and** at start (a draft must not be walked into a state create would
have rejected):
- an RM not in the active calling-role list — enforced server-side, not just hidden in
  the picker;
- an RM already in another running campaign at overlapping hours (`windows_overlap`,
  half-open, so 13:00-end and 13:00-start don't clash);
- a window that has already closed today (`window_has_passed`) — `_in_window` has no
  midnight wrap, so an 18:40 start on a 10:00–17:00 window would silently dial nobody
  until tomorrow.

**Pause** places no new calls; whatever is ringing rings out. **Stop** also marks the
remaining `pending` rows `skipped`, so it cannot be resumed.

Campaign rollups distinguish `targeted`, `unique_leads` (rows with ≥1 attempt) and
`total_calls` (`sum(attempts)`) — with retries on, calls exceed leads, so `attempts` is
the only honest call count.

## The tick

`start_dialer()` runs `_loop()` every `TICK_SECONDS = 3`, guarded by
`try_acquire_lock("dialer_tick")` — the DB claim stops two instances taking the same
lead, but not two of them ringing the same RM at once.

Each tick:

1. **Poll** open calls (below).
2. **Reap** stale rows — `dialing` with no callback for `STALE_AFTER_SECONDS = 420` is
   forced `done` with outcome `no callback`, so one dropped webhook can't wedge an RM for
   the rest of the campaign.
3. For each running campaign:
   - **Requeue** retries: `done`, `attempts < max_attempts`, `NOT answered`, cooldown
     elapsed → `pending` with `position + 1_000_000` (back of the queue). `rm_email`
     survives, which is the only thing that lets the lead's own RM claim it again under
     `assigned`.
   - **Finish** the campaign when nothing is pending, nothing is live and nothing is
     *retryable* (done-but-unconnected still inside its cooldown). Without that last
     term a multi-attempt campaign declares itself done during the cooldown gap and its
     retries never fire.
   - Skip if outside the IST calling window (blank/malformed = always on).
   - **Pick free RMs**: no live call, and past `gap_seconds` since their last hangup.
     Order by fewest-done (`least_load`) or longest-idle (`round_robin`); under
     `assigned` the order decides nothing.
   - **Dial** each free RM. No early exit — one RM running dry says nothing about the
     rest.

### `_dial_next` — claiming a lead

```sql
UPDATE dial_queue SET status='dialing', rm_email=:rm, event_id=:ev,
                      outcome=NULL, detail=NULL,
                      attempts=attempts+1, dialed_at=now(), ended_at=NULL
 WHERE id = (SELECT id FROM dial_queue
              WHERE campaign_id=:cid AND status='pending' [AND rm_email=:rm]
              ORDER BY position, id LIMIT 1 FOR UPDATE SKIP LOCKED)
```

- `FOR UPDATE SKIP LOCKED` — two instances can't claim the same lead.
- `event_id` is **reserved before the call is placed**: Bonvoice can fire the hangup
  callback before its own HTTP response arrives, and a slot whose id lands late would
  never be released.
- `outcome`/`detail` are cleared, or a redial would report the previous attempt's result.

Then `place_bridge()` with `callBackParams = {lead_id, actor, campaign_id}`. On success
it publishes `{"type":"call_started"}` to the RM's channel — the event the Live Calls
page exists for.

Failure to place: `_release()` puts the slot back to `pending` (attempts remain) or marks
it `failed`, recording the reason verbatim — RM has no mobile on file → retry; lead has
no usable phone → fail; Bonvoice error → retry while attempts remain.

### The poller fallback

Callbacks are the fast path; polling is what makes the dialer work without them.
`poll_open_calls()` takes up to `POLL_BATCH = 20` calls that have been `dialing` longer
than `POLL_AFTER_SECONDS = 20`, and asks `fetch_call_state()` how each went — at most
once per `POLL_EVERY_SECONDS = 15` per call, tracked in a self-pruning process-local
dict, so a 20-minute call doesn't mean 400 requests.

An ended call is closed with the same shape as the webhook's release (keyed by `id`
instead of `event_id`) and publishes `call_ended`, because on this path the RM's page
would otherwise sit on "Ringing…" for a call that finished minutes ago. `None` state
means "couldn't tell" — leave it; the stale reaper is the backstop.

## Tests

[backend/tests/test_dialer.py](../../backend/tests/test_dialer.py) — the compiler
whitelist, window maths, overlap detection, strategy ordering.
