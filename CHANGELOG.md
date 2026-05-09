# Changelog — Direct Inventory Portal

All prod-affecting changes go here. Newest at the top. Format: `YYYY-MM-DD — short summary`.

## 2026-05-06

- Backend live on Render at `https://direct-inventory.onrender.com` — health check returns OK with both DB connections green.
- Frontend live on Vercel at `https://direct-inventory-portal.vercel.app` (`supportopenhouses-projects` team). The `/api/*` proxy to Render is verified.
- Switched all references from the placeholder `direct-inventory-portal.onrender.com` to the actual `direct-inventory.onrender.com`.

## Unreleased

- Inventory cards (and detail modal) now show a Variation column = (asking − OH Price) / OH Price × 100. Color-coded: red when asking is above OH (less attractive), green when below (more attractive), gray within ±0.5%. Em-dash when OH Price is missing.

- OH Pricing source sheet moved to `1LC82Cg1OlOAL6cqpEJRl1Xrzwso5d1D8ApK-koFR2bY`. Apps Script body is unchanged (it reads from `getActiveSpreadsheet()`); only the doc-comment header is updated. The Apps Script must now be re-installed inside the *new* sheet, and the *old* sheet's trigger must be deleted to avoid dueling syncs.

- OH Pricing normalizer now matches the actual sheet headers:
  - Area: `sqft` (Gurgaon tab) and `size_sqft` (Noida + GZB tab) added.
  - Price: `selling_price_l` and `sell_price_l` added; both are auto-converted from ₹L (lakhs) to ₹ (×100,000) before being stored.
  - 7 new pytest cases pin both column conventions so any future sheet-header rename will fail tests before deploy.

- OH Price: new `oh_pricing` table (migration 004) populated from the OH Price Google Sheet. Two source sheets: "Gurgaon" and "Noida + GZB". Lookup key is society + BHK + closest area (±150 sqft).
- New backend endpoint `POST /api/sync/oh-pricing` — per-source-sheet replace (DELETE then bulk INSERT). Auth via the existing `X-Sync-Token`.
- `GET /api/inventory` now LEFT JOIN LATERAL with `oh_pricing` to attach the best-matching `oh_price` (plus the matched `oh_price_bhk` and `oh_price_area`) to every row returned.
- Frontend: inventory cards show OH Price alongside Asking Price (green when matched, em-dash when no match). The detail modal shows a richer line including matched BHK / area.
- New Apps Script `apps_script/sync_oh_pricing.gs` — weekly Friday trigger that pushes both sheet tabs to the backend; chunked at 500 rows per POST.
- Refactored `_scope_clause` and inventory list filters to support optional table aliases (the LATERAL join needs `i.` prefixes; the COUNT query stays unaliased).

- Add Inventory modal: Source defaults to "Website"; City → Society (datalist sourced from `properties.master_societies` for the selected city) → Locality (datalist of distinct localities, auto-filled when a known society is picked); "Price" relabelled to "Asking Price"; Listing link is now optional. Backend POST /api/inventory accepts no listing_link and auto-generates an `internal://manual/<uuid>` placeholder so dedup still works.
- New backend endpoint `GET /api/inventory/societies?city=X` — distinct society + locality pairs for the city, honoring the Noida = Noida + Greater Noida merge.
- Inventory cards added through the UI (source = "Website" or "manual") get an orange left border + warm-tan background so they're visually distinct from crawled rows.
- Admin Users page: switching the role to "admin" auto-selects all cities (admin needs cross-city visibility by default).
- OH-IDs for manually added rows continue from the same per-city counter — no separate pool.

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
