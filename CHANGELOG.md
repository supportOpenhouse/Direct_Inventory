# Changelog — Direct Inventory Portal

All prod-affecting changes go here. Newest at the top. Format: `YYYY-MM-DD — short summary`.

## 2026-05-06

- Backend live on Render at `https://direct-inventory.onrender.com` — health check returns OK with both DB connections green.
- Frontend live on Vercel at `https://direct-inventory-portal.vercel.app` (`supportopenhouses-projects` team). The `/api/*` proxy to Render is verified.
- Switched all references from the placeholder `direct-inventory-portal.onrender.com` to the actual `direct-inventory.onrender.com`.

## Unreleased

- Table: new Floor column (F{n}) between BHK and Area.
- CP Inventory match annotation. Each row in the table is matched against the CP Inventory Portal DB (new env var `CP_DB_URL`, optional `CP_INVENTORY_TABLE` defaulting to `inventory`). Match key normalizes society + BHK + floor (and tower + unit when checking for a perfect hit). A 🟢 green ★ next to the society name = perfect match (society + BHK + floor + tower + unit_no all match). A 🔴 red ★ = partial match (society + BHK + floor only). No star = no match, or `CP_DB_URL` not configured / unreachable. CP DB failure is non-fatal — the rows just show without stars.
- Migration 009 adds `tower TEXT, unit_no TEXT` to `inventory`. Sheet sync fills them in when the daily sheet has columns named tower / tower_no / tower_name / block and unit_no / unit / flat_no / flat_number — and uses `COALESCE` on update so manual entries aren't clobbered by syncs of sheets that don't have those fields. AddInventoryModal and the card detail modal expose both fields for manual entry/edit.

- Board: dropped the kanban + card view, replaced with a single dense table. Columns (left to right): ☐ ★ OH-ID City Society BHK Area Asking OH-Price Variation Stage Seller Phone Posted Follow-up. Locality and Source moved to the detail modal only. Row click opens the existing detail modal. Manual rows keep their orange left rail; priority rows keep the gold rail (gold wins when both apply); selected rows get a warm fill. Sortable headers on Asking / OH Price / Variation / Posted / Follow-up. Priority always floats to the top regardless of the active sort.
- Stage chips on top are now multi-select — clicking several combines with OR; "All" clears them.
- Backend list endpoint accepts CSV `?stage=a,b,c` and a whitelisted `?sort=<field>&dir=asc|desc` (price, oh_price, variation, posting_date, follow_up_at, updated_at). Variation sort is computed in-SQL.
- Removed `InventoryCard.jsx`; extracted its detail-modal half into a new `CardDetailModal.jsx` (no behaviour change — same edit flows: notes, seller name/phone, follow-up, stage, priority, with the same visit-schedule and reject-reason sub-modals).

- Stages refactor. Board now shows 5 stages instead of 7: `Qualified → Call Not Received → Follow Up → Visit Scheduled → Rejected`. The old `Follow Up (CNR)` stage is split into `Call Not Received` (first-attempt failed) and `Follow Up` (ongoing conversation). Migration 008 rewrites every `follow_up_cnr` row to `call_not_received`. `Visit Completed`, `Offer Given`, and `Unreachable` are dropped from the board; legacy rows in those stages stay in the DB but stop appearing in the kanban. Backend `VALID_STAGES` still accepts the legacy values so the Forms webhook can keep flipping completed visits to `visit_completed` (those rows will now silently leave the board).
- Logo: real Openhouse "H" mark in the topbar (dark mark, inverted for the dark header) and on the login card. Favicons swapped to the matching .ico + 16/32 px PNGs. Dropped the placeholder "OH" text mark and the duplicated "Openhouse" wordmark.

- Priority leads: admin/manager can flag any inventory row as Priority via a ★ button in the card header (and the detail-modal header). Priority rows float to the top of every kanban column (`ORDER BY priority DESC, updated_at DESC`), render with a gold left-rail, and can be isolated via a new "Priority only" checkbox in the FilterPanel. Bulk action bar gets two new actions: Mark Priority and Unmark Priority. RMs see the gold star on flagged rows but can't toggle it. Migration 007 adds `priority BOOLEAN NOT NULL DEFAULT FALSE` + a partial index. Sheet sync explicitly does not touch the column, so daily upserts preserve any flags set by managers.
- Follow-up date inputs (card detail + bulk action bar) now reject past dates via `min={today}`. `todayISO()` helper added in `utils/format.js` — uses local-date components, not UTC, so IST users don't see the wrong floor in the early-morning hours.

- Card select-mode checkbox moved from the top-left (where it was overlapping the society name) to the bottom-right. Reserved space with `padding-bottom: 36px` so it doesn't overlap the card foot, and gave it a white background + faint border so it stays readable over both crawled (white) and manual (warm-tan) cards.
- Contact No. field on the card detail modal is now strictly 10 digits, digits-only. `type="tel"` + `inputMode="numeric"` + `maxLength={10}`, and onChange strips non-digits before setting state. Existing legacy values (e.g. `vayby45556666665`) stay visible until edited, at which point they're cleaned to digits-only.

- Filter panel: Society field becomes an autocomplete (datalist) sourced from `/api/inventory/societies`. A city dropdown sits on its left to scope the suggestions — without a city, no suggestions show (1138 societies across all 3 cities is too noisy). When the panel opens, it pre-fills the city from the currently active top-tab city. The scope city is purely a UX helper for autocomplete and does NOT add a separate board-level city filter (top tabs remain the source of truth for that).

- Migration 006 adds `seller_phone TEXT` and `follow_up_at DATE` (+index) to `inventory`.
- Card detail modal: "Seller" relabelled to "Seller Name"; new editable Contact No. and Follow-up date fields right next to it. Card foot shows a follow-up chip when set. Each field saves on blur (PATCH /api/inventory/<oh_id>).
- New Filter panel (button next to Search). Filters: Society contains, BHK multi-select, Asking-price min/max (₹), Variation % min/max, Date-posted with presets (Today / Yesterday / This Week / This Month / Custom), Source. Active filters show on the button as a count and reset with one click. Backend endpoints accept the corresponding query params; `/api/inventory/counts` now honors them too so chips stay accurate.
- Bulk update: new Select toggle in the toolbar enables checkboxes on every card. With ≥1 selected, a dark action bar slides in offering Change Stage (with reject-reason picker), Assign RM, Set Follow-up Date. Backend: new `POST /api/inventory/bulk-update` with per-row visibility checks (rm sees only own; manager only own cities; admin all), `visit_scheduled` rejected (needs per-row modal), one activity_log row per (entity, field) tagged `bulk_*`.
- Refactor: list + counts queries share one LATERAL-joined subquery (`_INVENTORY_WITH_PRICING_SQL`). Variation filter is applied as an outer wrapper so it works on both endpoints. `_build_filters` helper consolidates the query-param parsing.

- BUGFIX: Board search was racy. Every keystroke fired a re-fetch via useEffect, and an older request (e.g. for `q="a"`) sometimes resolved AFTER the newer `q="amrapali"` request and overwrote the state with non-matching rows. Split into qInput (typed text) and qApplied (committed search) — search only takes effect on submit/Enter, plus a Clear button when a search is active.
- BUGFIX: Kanban column header showed `list.length` when counts.by_stage was missing the stage key, while the chip showed 0 — visibly inconsistent. Backend `/api/inventory/counts` now zero-fills every stage in the response, and the frontend uses 0 as the fallback.

- OH Price displayed on cards is now the Acq Price column (★ Acq Price (₹L) on Gurgaon, L2 Acq (₹L) on Noida + GZB) instead of the Selling Price column. The redundant separate "ACQ PRICE" pill is removed from the card and the detail modal — there's just one OH PRICE pill, and Variation is computed against it. Backend LATERAL JOIN now reads `acq_price` and only matches rows where acq_price is non-null. The selling-price column is still captured in `oh_pricing.price` but isn't surfaced to the UI.

- BUGFIX: OH Pricing batched sync was wiping the table on every batch's POST. Each call to `run_pricing_sync` started with `DELETE FROM oh_pricing WHERE source_sheet=X`, so when Apps Script sent N batches, only the last batch's rows survived (Gurgaon ended up with 451 rows instead of 2,451; Noida + GZB with 336 instead of 4,336). Backend now respects an `is_first_batch` flag — only the first batch deletes; subsequent batches append. Apps Script updated to set `is_first_batch: b === 0`.

- OH Pricing now also captures Acq Price: from "★ Acq Price (₹L)" on the Gurgaon tab and "L2 Acq (₹L)" on the Noida + GZB tab (both auto-converted from lakhs). Migration 005 adds `acq_price BIGINT` to `oh_pricing`.
- LATERAL match relaxed: society + BHK now always returns the row with the closest area (no hard ±150 sqft cap). The query also returns a new `oh_price_match` column ('exact' | 'nearest' | 'no_area'). The UI prefixes nearest matches with `~` and renders them in amber instead of green; tooltip shows the matched BHK / area.
- Card adds an ACQ PRICE pill alongside ASKING / OH PRICE / VARIATION; detail modal grid adds an Acq Price row and labels the OH Price match as `nearest` vs `matched`.
- DB diagnostic on the live data: 89.9% of inventory rows reference societies that are not in the OH Pricing sheet at all; relaxing the area cap recovers ~120 rows but the dominant gap is sheet coverage.

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
