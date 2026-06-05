# Direct Inventory — Backend

Flask API for the Openhouse Direct Inventory portal. Ported from the original
`Direct_Inventory/backend` with the same logic, adapted to the rebuilt
frontend's contract (`frontend/src/api/mock.js`).

## What changed vs. the original backend

- **`lead` intake stage.** New rows (sheet sync, manual create, raw inserts)
  land in `lead` — the Leads board's "unqualified" column — and are worked
  into `qualified` and onward. Stage order is now
  `lead → qualified → call_not_received → follow_up → visit_scheduled → rejected`.
- **Reject reasons** are `ground_floor`, `listing_removed`, `duplicate`.
- **`GET /api/home/summary`** — one scoped aggregate powering the Summary
  quadrants (leads new/old, follow-up time buckets, rejected breakdown).
- **`POST /api/auth/dev`** — passwordless sign-in for the demo accounts, active
  only while `GOOGLE_OAUTH_CLIENT_ID` is unset (local dev).
- **`GET /api/post-token/counts`** — stub (zeroed). The Pipeline / acquisition
  tracker is not wired to the backend yet; only the visit-scheduled flow is
  (`api/visits.py`).
- The large `inventory.py` was split into the `api/inventory/` package:
  `_common` (blueprint + filters/scope), `lists`, `records`, `bulk`,
  `maintenance`.

## Layout

```
app.py              Flask app factory + /api/health
config.py           env-driven config
db.py               app / properties / CP DB connections
api/
  auth.py           Google + dev login, require_auth, /me
  home.py           /api/home/summary
  inventory/        list, counts, societies, notifications, record CRUD,
                    notes, bulk-update, assigned-rms, cp-match-scan, assign-missing
  users.py          user admin
  activity.py       activity log + per-user reports
  visits.py         Forms-app visit scheduling (the one acquisition link)
  sync.py           Apps Script push sync (sheet + oh-pricing)
  post_token.py     acquisition pipeline counts (stub)
services/           activity, assignment, cp_match, oh_id, oh_pricing_sync, sheet_sync
migrations/         001..020 SQL, applied in filename order
scripts/            bulk_seed, cleanup_qualified_to_rejected
tests/              pytest unit tests (oh_id, oh_pricing_sync)
```

## Environment

Copy `.env.example` to `.env` and fill it in. Keys:

| var | purpose |
| --- | --- |
| `DATABASE_URL` | app Postgres (leads, users, activity) |
| `PROPERTIES_DB_URL` | read-only acquisition / master_societies / field execs |
| `CP_DB_URL` | read-only CP Inventory Portal (match annotation); optional |
| `CP_INVENTORY_TABLE` | CP table name (default `submissions`) |
| `GOOGLE_OAUTH_CLIENT_ID` | Google sign-in; unset ⇒ dev login enabled |
| `ALLOWED_EMAIL_DOMAIN` | login domain gate (default `openhouse.in`) |
| `SYNC_TOKEN` | shared secret for the Apps Script sync endpoints |
| `FORMS_APP_URL` | Forms app base URL for visit scheduling |
| `FRONTEND_ORIGIN` | CORS allow-origin |
| `LOG_LEVEL` | logging level |

`JWT_SECRET` and `INTERNAL_API_KEY` are read from the environment too (with safe
dev defaults) — they are deployment secrets rather than part of `.env.example`.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# Apply migrations (filename order) against $DATABASE_URL, e.g.:
for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# Dev server (port 5060)
python -m backend.app          # from the repo root
# or production
gunicorn wsgi:app --bind 0.0.0.0:$PORT

pytest backend/tests           # from the repo root
```

To point the frontend at this API, set `VITE_USE_MOCKS=false` (and
`VITE_API_BASE` if not same-origin) in the frontend env.
