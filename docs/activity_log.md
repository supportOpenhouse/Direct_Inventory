# Activity Log

Append-only audit trail of who did what across the app — every stage change, edit,
assignment, note, login, and background sync run. One row per event, written in the
**same transaction** as the change it describes, so the log can never drift from the
data.

- **Table:** `activity_log` (migration `001_init.sql`)
- **Writer:** `backend/services/activity.py` (`log`, `log_many`, `bind_assigned_mgr`)
- **Read API:** `backend/api/activity.py` — blueprint `/api/activity`
- **UI:** `frontend/src/pages/Logs.jsx` (Admin → Logs)

---

## Table: `activity_log`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` PK | |
| `actor_user_id` | `INT → users(id)` `ON DELETE SET NULL` | who did it; null for system/background jobs |
| `actor_email` | `TEXT` | denormalized copy of the actor (survives user deletion) |
| `entity_type` | `TEXT NOT NULL` | what kind of thing changed (see below) |
| `entity_id` | `TEXT` | usually `inventory.oh_id`; text for flexibility |
| `action` | `TEXT NOT NULL` | the verb (see below) |
| `field` | `TEXT` | for `action='update'`, which column changed |
| `before_value` | `TEXT` | prior value (stringified) |
| `after_value` | `TEXT` | new value (stringified) |
| `metadata` | `JSONB` | free-form context: ip, user_agent, batch info, raw ids, sync counts, etc. |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

**Indexes:** `(entity_type, entity_id)`, `(actor_user_id)`, `(action)`, `(created_at DESC)`,
plus `(entity_id, created_at)` (023) and `(entity_id, action)` (030) for the per-lead
timeline and "has this lead been worked" lookups.

Append-only by convention — nothing updates or deletes rows.

### `entity_type` values
`inventory` · `user` · `auth` · `sync` · `supply_sync` · `cp_match_scan`

### `action` values
`create` · `update` · `stage_change` · `note_added` · `assigned_rms` · `assign_missing` ·
`auto_provision` · `login` · `upsert` · `run` · `sync_run` · `pricing_sync_run` ·
`visit_scheduled` · `visit_rescheduled` · `visit_cancelled` ·
`ticket_created` · `ticket_reply` · `ticket_closed`

---

## Writing — `services/activity.py`

The caller owns the transaction, so the log row commits together with the change:

```python
from ..services.activity import log as log_activity

with conn, conn.cursor() as cur:
    cur.execute("UPDATE inventory SET stage = %s WHERE oh_id = %s", (new, oh_id))
    log_activity(
        cur,
        actor_user_id=g.user["id"], actor_email=g.user["email"],
        entity_type="inventory", entity_id=oh_id, action="update",
        field="stage", before_value=old, after_value=new,
        metadata={"source": "board"},
    )
```

`log(cur, *, actor_user_id, actor_email, entity_type, entity_id, action, field=None,
before_value=None, after_value=None, metadata=None)`

- **User-id fields are auto-humanized.** `assigned_rm_ids` renders as `[Animesh Singh, Aman Dixit]`
  and `assigned_mgr_id` / `manager` as a name, instead of raw ids — the raw ids stay in
  `metadata` (`before_ids` / `after_ids`) so entries remain traceable.
- **`log_many(cur, rows)`** — batch-insert many rows in one round-trip (bulk edits, syncs).
- **`bind_assigned_mgr(entries)`** — folds an entity's `assigned_mgr_id` change into its
  `assigned_rm_ids` entry so a reassignment reads as one event, not two.

Written from: inventory records/bulk/maintenance, users, auth (login/auto-provision),
visits, tickets, and the sheet / supply / OH-pricing sync services.

---

## Reading — `/api/activity`

| Method · Path | Purpose |
|---|---|
| `GET /api/activity` | Filtered, sorted list (backs the Logs table) |
| `GET /api/activity/export` | Same filters/scope → CSV download |
| `GET /api/activity/filters` | Distinct actions / entity_types / actors for the dropdowns |
| `GET /api/activity/user-report` | Per-user activity report |
| `GET /api/activity/user-report/analytics` | Aggregated charts for a user |
| `GET /api/activity/user-report/days` | Per-day breakdown |
| `GET /api/activity/user-report/leads` | Leads a user touched |

**List query params:** `q` (free-text over actor name/email, action, category, field,
entity_id), `action`, `entity_type`, `actor_email` (`apps-script:*` groups the sheet
batches), `from` / `to` (IST dates), `sort`, `dir`, `limit` (default 500).

**Scope:** admins see everything; **managers** are restricted to `inventory` activity for
leads in their cities (non-inventory events are still visible) — same city convention as
`inventory._scope_clause`.

---

## Frontend — Logs page (`pages/Logs.jsx`)

Admin-only table: timestamp · UID · actor · action · category · details. The **Details**
column renders human summaries per action (stage change `A → B`, note added, visit
scheduled, sync run counts, etc.). Filters (search, action, category, actor, date range)
and **Download CSV** mirror the list endpoint; a UID starting `OHL…` opens that lead's
detail popup.
