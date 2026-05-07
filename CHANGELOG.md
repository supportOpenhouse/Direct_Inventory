# Changelog — Direct Inventory Portal

All prod-affecting changes go here. Newest at the top. Format: `YYYY-MM-DD — short summary`.

## 2026-05-06

- Backend live on Render at `https://direct-inventory.onrender.com` — health check returns OK with both DB connections green.
- Frontend live on Vercel at `https://direct-inventory-portal.vercel.app` (`supportopenhouses-projects` team). The `/api/*` proxy to Render is verified.
- Switched all references from the placeholder `direct-inventory-portal.onrender.com` to the actual `direct-inventory.onrender.com`.

## Unreleased

- Visit Schedule modal: separate Date and Time fields, Field Exec dropdown sourced from `properties.users WHERE can_visit=TRUE`, "Assigned by: <current user>" line. Replaces the single datetime-local input + free-text phone.
- New backend endpoint `GET /api/visits/field-execs` that surfaces the filtered properties.users list (read-only).
- Stage-chip counts at the top of the board now refresh automatically after a card's stage changes (was stale after edits).

- Card detail is now a centered popup modal instead of an inline panel below the card. Same fields (listing, posted, seller, source, stage, notes) plus a header strip with society/OH-ID/city/stage-dot.
- Reject reason is a proper dropdown modal with the 6 labels (no more `window.prompt` asking for slugs). Selecting Rejected opens the modal; the row only flips after the user picks a reason.

- Board: stage chips at the top are now clickable filters. Selecting one switches to a paginated single-column view (100 per page) for that stage; "All" returns to the kanban.
- Board: kanban view now does one parallel API call per stage (top 50 each), with a "View all N →" link in each column when there's more.
- Board: counts shown on the chips come from a new `/api/inventory/counts` endpoint and are DB-wide, not just the current page's items.
- City: Greater Noida is rolled up under Noida everywhere — city tabs are `Gurgaon, Noida, Ghaziabad` (in that order); inventory cards display the chip as `NOIDA` even for `Greater Noida` rows; backend `?city=Noida` matches both `Noida` and `Greater Noida`.
- backend/scripts/bulk_seed.py — one-shot bulk seed from a CSV export (used to seed the initial 15k+ rows directly to Neon, bypassing Render).

- Sheet sync: wrap each row in a `SAVEPOINT` so a single bad row no longer cascades-aborts the rest of the batch. Surface up to 5 error samples in the response body so sync failures are diagnosable from the Apps Script log.
- Render: bump gunicorn `--timeout` from 60s to 180s in render.yaml (must also be updated in dashboard, since service was set up manually).
- Apps Script: chunked sync — splits the sheet into 200-row batches per POST, prefixed all symbols with `DI_` so it can coexist with other Apps Scripts in the same project.

- Initial scaffold (2026-05-06).
  - DB schema: `inventory`, `users`, `rm_mapping`, `oh_id_counter`, `activity_log`.
  - OH-ID generator with full unit tests (per-city counter + suffix rollover).
  - Backend: 20 routes — auth, inventory CRUD, RM mapping, users, sheet sync, Forms-app integration, activity log.
  - Frontend: Kanban board with city tabs, search, stage counts; add-inventory + visit-schedule modals; admin pages for users, RM mapping, activity log.
  - Google OAuth login restricted to `@openhouse.in` Workspace.
  - Seed migrations: `ashish@openhouse.in` (admin), `saransh.khera@openhouse.in` (manager, all cities), `sahaj.dureja@openhouse.in` (RM, Noida).
  - **Sheet sync model: switched from pull (service-account + Sheets API) to push (Apps Script time trigger POSTs sheet rows to `/api/sync/sheet`).** Drops `google-api-python-client` dep and the entire service-account setup. Mirrors the CP portal's `acq_sync.gs` pattern.
  - **Not yet deployed.** Awaiting OAuth Client ID wiring, Neon DB, GitHub repo, Vercel + Render projects.
