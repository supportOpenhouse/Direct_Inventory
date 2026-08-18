# Call Log page, filters and recordings

Every call leg Bonvoice has reported, newest first, with its recording.

**Rows are legs, not calls.** A bridged call writes one row for the RM's handset (`A`)
and one for the lead (`B`). The leg letter itself isn't shown — it's noise next to the
numbers.

## Endpoints

```
GET /v1/bonvoice/calls          admin — the list
GET /v1/bonvoice/calls/actors   admin — the "Calls placed by" dropdown
GET /v1/leads/{lead_id}/calls   any user — one lead's history (50 newest)
```

`GET /v1/bonvoice/calls` parameters:

| Param | Meaning |
|---|---|
| `q` | any phone number or the lead's name |
| `answered` | `true` / `false` — Connected / Not connected |
| `campaign_id` | only calls one auto-dialer campaign placed |
| `placed_by` | an actor email, or `by-lead`, or `unknown` |
| `duration` | one of `<1 min`, `1-3 mins`, `3-5 mins`, `5+ mins` |
| `limit` (≤200), `offset` | paging; the page uses 50 |

Returns `{ items, total }`. The filter clause is built once in `call_log_filters()` so
the page and its count can't disagree, and so it's testable without a database.

Previous Campaigns reuses this same endpoint with `campaign_id` rather than running its
own query — a campaign's calls then render in exactly the same shape as the Call Log.

## Filter semantics

**Phone search.** `q` matches the three number columns and `l.name` with `ILIKE`, *and*
— when the query contains ≥10 digits — on last-10 digits, so `+91 99997 99588`,
`919999799588` and `9999799588` all find the same calls.

`_p10_sql(col)` = `right(regexp_replace(col, '\D', '', 'g'), 10)`. The three stores
format numbers differently (Bonvoice `9220633844`, `users.phone` `919999999999`,
`leads.phone` `+91 99997 99588`); last-10 is the one key they all agree on.

**Placed by.** `COALESCE(c.placed_by, c.raw->'callBackParams'->>'actor')` — the dialer
writes the column directly, a click-to-call echoes it back inside `callBackParams`.
Defined once (`PLACED_BY_SQL`) so the SELECT and the filter can't diverge.

Three mutually exclusive choices, a true partition:

| Value | Meaning |
|---|---|
| an email | that actor **and** not a lead-placed row |
| `by-lead` | the lead is on the *From* side — they rang us |
| `unknown` | no actor recorded **and** not lead-placed |

An inbound call can carry an actor too (the sync matches the RM who *received* it), but
the column says "Placed by" and inbound rows show the lead there — so filtering by an RM
must not return calls the lead placed. Neither sentinel can collide with a real value:
every actor is an email, and neither sentinel has an `@`.

**Duration buckets** are half-open and contiguous — `[0,60) [60,180) [180,300) [300,∞)`.
Inclusive-looking bounds (…59 / 181…) read fine but leave gaps: the column is a timestamp
difference, so a 59.5s call would match nothing. A leg with no `end_at` has unknown
length and matches **no** bucket rather than being counted as zero. The label *is* the
API value — `DURATION_OPTIONS` in `api.ts` must match `DURATION_BUCKETS` in
`routers/bonvoice.py`.

**`lead_side`** (`from` | `to` | NULL) tells the UI which side of *From → To* the lead is
on: outgoing puts them in the destination; when they ring us they're the source and
nobody here placed the call, so the UI credits the lead.

**Actors** are computed server-side (`SELECT DISTINCT`) because the page holds 50 rows at
a time; deriving the dropdown from what's on screen would hide every RM not on the
current page.

## Recordings

`recording_url` arrives on the hangup callback as `ResourceURL` (their docs) /
`resourceurl` (their support) — read case-insensitively rather than lose recordings to a
capital letter. On [pulled records](call-record-sync.md) the field is `CallRecord`, and
it is dropped for zero-second calls because fetching it answers "File not exist".

[RecordingPlayer.tsx](../../frontend/src/components/RecordingPlayer.tsx) — one button, a
progress ring, elapsed time. It replaces `<audio controls>`, which renders a different
widget in every browser and is far too wide for the table cell; the `<audio>` element
still does the work, it just doesn't draw itself. Two guards worth keeping: Bonvoice
streams some files without a length, so `duration` can be `Infinity`/`NaN` and would
render NaN into the DOM; and pressing play pauses whatever else is playing, or 25 rows
of recordings stack on top of each other.

## Pages

- [CallLog.tsx](../../frontend/src/pages/CallLog.tsx) — the admin table, filters, and the
  **Sync from Bonvoice** backfill control (default window: last 30 days).
- [CallActivityCard.tsx](../../frontend/src/components/CallActivityCard.tsx) — per-lead
  history on lead detail, with recordings. Renders nothing until a call has been made;
  an empty card on a lead nobody has rung is just noise in the column.
