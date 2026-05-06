# Changelog — Direct Inventory Portal

All prod-affecting changes go here. Newest at the top. Format: `YYYY-MM-DD — short summary`.

## 2026-05-06

- Backend live on Render at `https://direct-inventory.onrender.com` — health check returns OK with both DB connections green.
- Switched all references from the placeholder `direct-inventory-portal.onrender.com` to the actual `direct-inventory.onrender.com`.

## Unreleased

- Initial scaffold (2026-05-06).
  - DB schema: `inventory`, `users`, `rm_mapping`, `oh_id_counter`, `activity_log`.
  - OH-ID generator with full unit tests (per-city counter + suffix rollover).
  - Backend: 20 routes — auth, inventory CRUD, RM mapping, users, sheet sync, Forms-app integration, activity log.
  - Frontend: Kanban board with city tabs, search, stage counts; add-inventory + visit-schedule modals; admin pages for users, RM mapping, activity log.
  - Google OAuth login restricted to `@openhouse.in` Workspace.
  - Seed migrations: `ashish@openhouse.in` (admin), `saransh.khera@openhouse.in` (manager, all cities), `sahaj.dureja@openhouse.in` (RM, Noida).
  - **Sheet sync model: switched from pull (service-account + Sheets API) to push (Apps Script time trigger POSTs sheet rows to `/api/sync/sheet`).** Drops `google-api-python-client` dep and the entire service-account setup. Mirrors the CP portal's `acq_sync.gs` pattern.
  - **Not yet deployed.** Awaiting OAuth Client ID wiring, Neon DB, GitHub repo, Vercel + Render projects.
