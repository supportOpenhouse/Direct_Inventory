# Openhouse Direct Inventory Portal

Internal dashboard for Openhouse to triage **directly-crawled** residential resale leads (99acres, magicbricks, etc.). The crawler dumps into a Google Sheet; this portal pulls from the sheet daily, layers a workflow on top (Kanban stages, RM assignment, notes, visit scheduling), and writes nothing back to the sheet.

Sister project of the [CP Inventory Portal](https://github.com/supportOpenhouse/CP-Inventory-Portal). Same stack and conventions, different data source and roles.

## Stack
- **Frontend**: Vite + React 18, `@react-oauth/google` for login, plain CSS.
- **Backend**: Flask + psycopg2 + PyJWT, gunicorn in prod.
- **DB**: Postgres 15 on Neon — app DB `openhouse-direct-portal` (read/write) and shared `properties` DB (read-only).
- **Auth**: Google OAuth restricted to `@openhouse.in` Workspace (Internal app).
- **Hosting**: Vercel (frontend) + Render (backend). Daily sync is pushed by an Apps Script trigger living inside the data sheet.

## Pipeline stages
`Qualified → Follow Up (CNR) → Visit Scheduled → Visit Completed → Offer Given`
plus `Unreachable` and `Rejected` (with sub-reasons: Not Interested, Invalid/Duplicate, Future Prospect, OH Rejected, Sold, Broker Listing).

## OH-ID format
`OHL{CITY}D{NNNN}{SUFFIX}` — e.g. `OHLND0001`, `OHLND9999`, `OHLND0001A`, `OHLND9999A`, `OHLND0001B`…
- `CITY`: `G` (Gurgaon), `N` (Noida + Greater Noida), `GH` (Ghaziabad)
- `NNNN`: 0001..9999 zero-padded, per-city
- `SUFFIX`: `''` → `A` → `B` → … on each rollover

## Roles & visibility

| Role | Sees | Edits |
| --- | --- | --- |
| `admin` | everything | everything |
| `manager` | rows in their assigned cities | same |
| `rm` | rows assigned to them | same |

RM/manager assignment uses the `rm_mapping` table — resolution order **society > locality > city**. Admins manage mappings in-app at `/admin/mapping`. Unknown emails who log in get auto-provisioned as `rm` with no city; an admin must activate them.

## Local dev

```bash
# 1. Backend (run from repo root)
cp backend/.env.example backend/.env   # fill DATABASE_URL, GOOGLE_OAUTH_CLIENT_ID, etc.
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
psql "$DATABASE_URL" -f backend/migrations/001_init.sql
psql "$DATABASE_URL" -f backend/migrations/002_seed_admin.sql
psql "$DATABASE_URL" -f backend/migrations/003_seed_test_users.sql
.venv/bin/python -m backend.app        # http://localhost:5060
# (production: gunicorn wsgi:app — entry point is wsgi.py at repo root)

# 2. Frontend
cd frontend
cp .env.example .env                   # fill VITE_GOOGLE_OAUTH_CLIENT_ID
npm install
npm run dev                            # http://localhost:5174
```

Port choices avoid clashing with the CP portal (5050 / 5173).

## Tests

```bash
cd backend && .venv/bin/pytest -q
```

The OH-ID generator has full unit test coverage (rollover, suffix progression, city aliasing). Most route handlers are integration-tested via the live Render deploy rather than locally — the assumption matches the CP portal pattern.

## Sheet sync

- **Sheet** is the source of truth for raw lead data. It is read-only from this app's perspective.
- **App DB** is the source of truth for workflow state (`stage`, `notes`, `assigned_rm_id`, `oh_id`, `activity_log`).
- Sync runs daily at ~**11:30 IST** via an Apps Script time trigger inside the sheet, which POSTs to `/api/sync/sheet` with the shared `X-Sync-Token`. Pattern mirrors the CP portal's `acq_sync.gs`.
- Apps Script source: [apps_script/sync_direct_inventory.gs](apps_script/sync_direct_inventory.gs).
- To trigger manually, run `runSync()` in the Apps Script editor.
- Dedup key is `listing_link`.
- Rows removed from the sheet stay in the app (never auto-deleted).

## Forms app integration (Visit Scheduling)

When a lead moves to `visit_scheduled`, the Visit Schedule modal opens and `POST /api/visits/schedule` forwards to `{FORMS_APP_URL}/api/external/schedule` with the shared `INTERNAL_API_KEY`. When the visit is marked complete in Forms, Forms calls back to `POST /api/visits/forms-webhook` and we flip the row to `visit_completed`.

The webhook URL needs to be added to the Forms-app config: `https://direct-inventory.onrender.com/api/visits/forms-webhook`.

## Conventions (inherited from CP portal)

1. `git pull` before every edit.
2. Migrations BEFORE backend deploys (Render auto-deploys on push).
3. Render free tier deploys lag 2–5 min + 30–60s cold start.
4. No CHECK constraint on stage — code-only enforcement.
5. `properties` DB is READ-ONLY.
6. Loose files, no zips.
7. Update `CHANGELOG.md` on every prod push.
8. Push to prod only after explicit approval.

## Files

```
backend/
  app.py                     # Flask entrypoint, blueprint registration
  config.py                  # env vars
  db.py                      # connection helpers (app + properties)
  api/
    auth.py                  # Google OAuth + JWT issuer + require_auth decorator
    inventory.py             # list/get/create/patch + visibility scoping
    rm_mapping.py            # admin RM/locality CRUD
    users.py                 # user management
    sync.py                  # POST /api/sync/sheet — Apps Script push receiver
    visits.py                # Forms app schedule + webhook
    activity.py              # activity log read
  services/
    oh_id.py                 # OH-ID generator (per-city counter, suffix rollover)
    assignment.py            # resolve_assignment(city, locality, society)
    sheet_sync.py            # row normalization + upsert from pushed payload
    activity.py              # log() helper
  migrations/
    001_init.sql             # schema
    002_seed_admin.sql       # seed first admin
  tests/
    test_oh_id.py            # 11 unit tests
frontend/
  src/
    App.jsx                  # routes + role guard
    main.jsx                 # GoogleOAuthProvider + AuthProvider
    contexts/AuthContext.jsx
    api/client.js            # tiny fetch wrapper with bearer token
    utils/format.js          # price/date/stage helpers
    components/
      Layout.jsx             # topbar + nav
      InventoryCard.jsx      # card + expand panel + notes
      AddInventoryModal.jsx  # manual lead entry
      VisitScheduleModal.jsx # Forms-app handoff
    pages/
      Login.jsx              # Google sign-in
      Board.jsx              # Kanban + counts + search
      AdminUsers.jsx
      AdminMapping.jsx
      AdminActivity.jsx
apps_script/
  sync_direct_inventory.gs   # daily 11:30 IST trigger; POSTs sheet rows to backend
docs/
  OAUTH_SETUP.md             # GCP setup walkthrough
CHANGELOG.md
```
